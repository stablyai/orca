import { canRoundTripRichMarkdown, getRichMarkdownRoundTripOutput } from './markdown-round-trip';
import { extractFrontMatter } from './markdown-frontmatter';
const UNSUPPORTED_PATTERNS = [
    {
        reason: 'html-or-jsx',
        message: 'Editable only in code mode because this file contains HTML, JSX, or MDX.',
        // Why: the rich editor preserves common embedded markup via placeholder
        // tokens before parsing, but any HTML shape that still fails round-trip
        // must fall back instead of risking silent source corruption.
        pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/
    },
    {
        reason: 'reference-links',
        message: 'Editable only in code mode because this file contains reference-style links.',
        pattern: /^\[[^\]]+\]:\s+\S+/m
    },
    {
        reason: 'footnotes',
        message: 'Editable only in code mode because this file contains footnotes.',
        pattern: /^\[\^[^\]]+\]:\s+/m
    }
];
export function getMarkdownRichModeUnsupportedMessage(content) {
    // Why: front-matter is handled externally — stripped before the rich editor
    // sees the content and displayed as a read-only block. Only the body needs
    // to pass the unsupported-content checks.
    const fm = extractFrontMatter(content);
    const body = fm ? fm.body : content;
    const contentWithoutCode = stripMarkdownCode(body);
    if (canRoundTripRichMarkdown(body)) {
        return null;
    }
    // Why: HTML/JSX gets special treatment — if the round-trip output preserves
    // the embedded markup, we allow rich mode even though the pattern matched.
    // Looked up by reason (not index) so reordering the array won't break this.
    const htmlMatcher = UNSUPPORTED_PATTERNS.find((m) => m.reason === 'html-or-jsx');
    if (htmlMatcher && htmlMatcher.pattern.test(contentWithoutCode)) {
        const roundTripOutput = getRichMarkdownRoundTripOutput(body);
        if (roundTripOutput && preservesEmbeddedHtml(contentWithoutCode, roundTripOutput)) {
            return null;
        }
    }
    for (const matcher of UNSUPPORTED_PATTERNS) {
        if (matcher.pattern.test(contentWithoutCode)) {
            return matcher.message;
        }
    }
    // Why: Tiptap rewrites some harmless markdown spellings such as autolinks or
    // escaped angle brackets even when the rendered document stays equivalent.
    // Preview mode should stay editable unless we have a specific syntax we know
    // the editor will drop or reinterpret in a user-visible way.
    return null;
}
function stripMarkdownCode(content) {
    const lines = content.split(/\r?\n/);
    const sanitizedLines = [];
    let activeFence = null;
    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            const fenceMarker = fenceMatch[1][0];
            activeFence = activeFence === fenceMarker ? null : fenceMarker;
            sanitizedLines.push('');
            continue;
        }
        if (activeFence) {
            sanitizedLines.push('');
            continue;
        }
        sanitizedLines.push(line.replace(/`+[^`\n]*`+/g, ''));
    }
    return sanitizedLines.join('\n');
}
function preservesEmbeddedHtml(contentWithoutCode, roundTripOutput) {
    const htmlFragments = contentWithoutCode.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/g) ?? [];
    let searchIndex = 0;
    for (const fragment of htmlFragments) {
        const foundIndex = roundTripOutput.indexOf(fragment, searchIndex);
        if (foundIndex === -1) {
            return false;
        }
        searchIndex = foundIndex + fragment.length;
    }
    return true;
}
