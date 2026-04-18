const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1(?:\r?\n|$)/;
/**
 * Extracts a YAML (`---`) or TOML (`+++`) front-matter block from the start
 * of a markdown document. Returns null if no front-matter is present.
 */
export function extractFrontMatter(content) {
    const match = content.match(FRONTMATTER_RE);
    if (!match) {
        return null;
    }
    const raw = match[0];
    const body = content.slice(raw.length);
    return { raw, body };
}
/**
 * Re-assembles a full markdown document from a raw front-matter block and body.
 * Ensures exactly one newline separates the front-matter block from the body.
 */
export function prependFrontMatter(raw, body) {
    // Why: the raw block captured by extractFrontMatter may or may not end with
    // a newline depending on whether the original document had a blank line after
    // the closing delimiter. Normalising to exactly one trailing newline prevents
    // accumulating extra blank lines on every save cycle.
    const normalizedRaw = raw.endsWith('\n') ? raw : `${raw}\n`;
    return `${normalizedRaw}${body}`;
}
