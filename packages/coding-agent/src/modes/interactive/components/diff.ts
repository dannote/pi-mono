import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Syntax highlight a single line of code.
 * Falls back to plain text if highlighting fails or language is unknown.
 */
function highlightLine(content: string, lang?: string): string {
	if (!lang) return content;
	const lines = highlightCode(content, lang);
	return lines[0] ?? content;
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path for syntax highlighting */
	filePath?: string;
}

/**
 * Render a diff string with colored lines, intra-line change highlighting, and syntax highlighting.
 * - Context lines: dim prefix with syntax-highlighted content
 * - Removed lines: red prefix with syntax-highlighted content, inverse on changed tokens
 * - Added lines: green prefix with syntax-highlighted content, inverse on changed tokens
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	const lang = options.filePath ? getLanguageFromPath(options.filePath) : undefined;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is with syntax highlighting.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				// For intra-line diff, we can't easily combine syntax highlighting with inverse markers
				// so we just use the diff colors
				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines - with syntax highlighting
				for (const removed of removedLines) {
					const content = replaceTabs(removed.content);
					const highlighted = highlightLine(content, lang);
					result.push(`${theme.fg("toolDiffRemoved", `-${removed.lineNum}`)} ${highlighted}`);
				}
				for (const added of addedLines) {
					const content = replaceTabs(added.content);
					const highlighted = highlightLine(content, lang);
					result.push(`${theme.fg("toolDiffAdded", `+${added.lineNum}`)} ${highlighted}`);
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line - with syntax highlighting
			const content = replaceTabs(parsed.content);
			const highlighted = highlightLine(content, lang);
			result.push(`${theme.fg("toolDiffAdded", `+${parsed.lineNum}`)} ${highlighted}`);
			i++;
		} else {
			// Context line - with syntax highlighting
			const content = replaceTabs(parsed.content);
			const highlighted = highlightLine(content, lang);
			result.push(`${theme.fg("toolDiffContext", ` ${parsed.lineNum}`)} ${highlighted}`);
			i++;
		}
	}

	return result.join("\n");
}
