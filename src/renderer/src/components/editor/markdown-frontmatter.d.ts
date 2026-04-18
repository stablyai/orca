export type FrontMatter = {
    /** The full raw front-matter block including delimiters and trailing newline. */
    raw: string;
    /** The document body after the front-matter block. */
    body: string;
};
/**
 * Extracts a YAML (`---`) or TOML (`+++`) front-matter block from the start
 * of a markdown document. Returns null if no front-matter is present.
 */
export declare function extractFrontMatter(content: string): FrontMatter | null;
/**
 * Re-assembles a full markdown document from a raw front-matter block and body.
 * Ensures exactly one newline separates the front-matter block from the body.
 */
export declare function prependFrontMatter(raw: string, body: string): string;
