import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AgentRequestIdentity, Context, Model } from "../src/types.ts";

afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "You are helpful.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

const identity: AgentRequestIdentity = {
	sessionId: "session-1",
	threadId: "thread-1",
	turnId: "turn-1",
	requestKind: "turn",
	startedAt: 123456789,
	installationId: "installation-é",
	windowId: "thread-1:0",
};

function token(accountId = "account-1"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

function completedEvents(responseId = "response-1"): Array<Record<string, unknown>> {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function captureWebSocketRequests(
	eventsForRequest = (index: number) => completedEvents(`response-${index}`),
	openConnection: (open: () => void) => void = queueMicrotask,
) {
	const handshakes: Array<Record<string, string> | undefined> = [];
	const urls: string[] = [];
	const frames: Array<{
		input: Array<Record<string, unknown>>;
		previous_response_id?: string;
		client_metadata?: Record<string, string>;
	}> = [];
	class MockWebSocket {
		readyState = 1;
		private listeners = new Map<string, Set<(event: unknown) => void>>();
		constructor(_url: string, options?: { headers?: Record<string, string> }) {
			urls.push(_url);
			handshakes.push(options?.headers);
			openConnection(() => this.dispatch("open", {}));
		}
		addEventListener(type: string, listener: (event: unknown) => void): void {
			const listeners = this.listeners.get(type) ?? new Set();
			listeners.add(listener);
			this.listeners.set(type, listeners);
		}
		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}
		send(data: string): void {
			frames.push(JSON.parse(data));
			const events = eventsForRequest(frames.length);
			queueMicrotask(() => {
				for (const event of events) {
					if (event.type === "test.close") this.close();
					else this.dispatch("message", { data: JSON.stringify(event) });
				}
			});
		}
		close(): void {
			this.readyState = 3;
			this.dispatch("close", { code: 1006 });
		}
		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected HTTP fallback");
		}),
	);
	return { handshakes, frames, urls };
}

function parseTurnMetadata(clientMetadata: Record<string, string>): Record<string, unknown> {
	return JSON.parse(clientMetadata["x-codex-turn-metadata"]);
}

function decodeRequestBody(body: RequestInit["body"] | undefined): Record<string, unknown> | undefined {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Record<string, unknown>;
	}
	return undefined;
}

describe("OpenAI Codex attribution", () => {
	it("sends canonical identity in SSE headers and client_metadata independently of caching", async () => {
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		const sse = `${completedEvents()
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers as Headers;
				capturedBody = decodeRequestBody(init?.body);
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			cacheRetention: "none",
			sessionId: "cache-session",
			requestIdentity: identity,
		}).result();

		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get("session-id")).toBe(identity.sessionId);
		expect(capturedHeaders?.get("thread-id")).toBe(identity.threadId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(identity.threadId);
		expect(capturedHeaders?.get("x-codex-window-id")).toBe(identity.windowId);
		expect(capturedHeaders?.get("x-codex-installation-id")).toBe(identity.installationId);
		expect(capturedBody?.prompt_cache_key).toBeUndefined();

		const clientMetadata = capturedBody?.client_metadata as Record<string, string>;
		expect(clientMetadata).toMatchObject({
			"x-codex-installation-id": identity.installationId,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			"x-codex-window-id": identity.windowId,
		});
		expect(parseTurnMetadata(clientMetadata)).toEqual({
			installation_id: identity.installationId,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			turn_id: identity.turnId,
			window_id: identity.windowId,
			request_kind: "turn",
			turn_started_at_unix_ms: identity.startedAt,
		});
		expect([...clientMetadata["x-codex-turn-metadata"]].every((character) => character.charCodeAt(0) < 128)).toBe(
			true,
		);
		expect(capturedHeaders?.get("x-codex-turn-metadata")).toBe(clientMetadata["x-codex-turn-metadata"]);
	});

	// #9481: new-turn attribution must not discard an otherwise valid input delta.
	it.each(["auto", "websocket-cached", "websocket"] as const)(
		"sends current metadata on reused %s frames without invalidating cached input",
		async (transport) => {
			const { handshakes, frames } = captureWebSocketRequests();
			const nextIdentity = { ...identity, turnId: "turn-2", startedAt: identity.startedAt + 1000 };
			const messages = [...context.messages];
			for (const requestIdentity of [identity, nextIdentity, undefined]) {
				const result = await streamOpenAICodexResponses(
					model,
					{ ...context, messages },
					{
						apiKey: token(),
						transport,
						sessionId: identity.sessionId,
						requestIdentity,
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
				messages.push(result, { role: "user", content: "next", timestamp: 2 });
			}
			expect(handshakes).toHaveLength(1);
			expect(handshakes[0]?.["session-id"]).toBe(identity.sessionId);
			expect(handshakes[0]?.["thread-id"]).toBe(identity.threadId);
			expect(handshakes[0]?.["x-client-request-id"]).toBe(identity.threadId);
			expect(JSON.parse(handshakes[0]!["x-codex-turn-metadata"]).turn_id).toBe(identity.turnId);
			expect(frames.map((frame) => frame.client_metadata?.turn_id)).toEqual([
				identity.turnId,
				nextIdentity.turnId,
				undefined,
			]);
			expect(parseTurnMetadata(frames[1].client_metadata!)).toMatchObject({
				turn_id: nextIdentity.turnId,
				turn_started_at_unix_ms: nextIdentity.startedAt,
				request_kind: "turn",
			});
			expect(frames[2].client_metadata).toBeUndefined();
			expect(frames.map((frame) => frame.previous_response_id)).toEqual(
				transport === "websocket" ? [undefined, undefined, undefined] : [undefined, "response-1", "response-2"],
			);
			expect(frames.map((frame) => frame.input.length)).toEqual(transport === "websocket" ? [1, 3, 5] : [1, 1, 1]);
			expect(frames[1].input.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "input_text", text: "next" }],
			});
		},
	);

	it.each(["instructions", "tools", "reasoning", "prefix", "shorter context"])(
		"still resends full input when metadata and %s change",
		async (change) => {
			const { frames } = captureWebSocketRequests();
			const options = {
				apiKey: token(),
				transport: "auto" as const,
				sessionId: identity.sessionId,
				requestIdentity: identity,
			};
			const first = await streamOpenAICodexResponses(model, context, options).result();
			expect(first.stopReason).toBe("stop");
			const nextContext: Context = {
				...context,
				messages: [...context.messages, first, { role: "user", content: "next", timestamp: 2 }],
			};
			if (change === "instructions") nextContext.systemPrompt = "Different instructions.";
			if (change === "tools")
				nextContext.tools = [{ name: "probe", description: "A new tool", parameters: Type.Object({}) }];
			if (change === "prefix") nextContext.messages[0] = { role: "user", content: "changed", timestamp: 1 };
			if (change === "shorter context") nextContext.messages = [{ role: "user", content: "next", timestamp: 2 }];
			const second = await streamOpenAICodexResponses(model, nextContext, {
				...options,
				requestIdentity: { ...identity, turnId: "turn-2", startedAt: 987654321 },
				...(change === "reasoning" ? { reasoningEffort: "high" as const } : {}),
			}).result();
			expect(second.stopReason).toBe("stop");
			expect(frames).toHaveLength(2);
			expect(frames[1].previous_response_id).toBeUndefined();
			expect(frames[1].input).toHaveLength(change === "shorter context" ? 1 : 3);
			expect(frames[1].client_metadata?.turn_id).toBe("turn-2");
		},
	);

	it("lets explicit headers override generated compatibility defaults", async () => {
		let capturedHeaders: Headers | undefined;
		const sse = `${completedEvents()
			.map((event) => `data: ${JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers as Headers;
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		await streamOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			requestIdentity: identity,
			headers: { originator: "custom", "thread-id": "custom-thread" },
		}).result();

		expect(capturedHeaders?.get("originator")).toBe("custom");
		expect(capturedHeaders?.get("thread-id")).toBe("custom-thread");
	});
});
