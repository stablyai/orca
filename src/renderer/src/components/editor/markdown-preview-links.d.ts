export declare function getMarkdownPreviewLinkTarget(rawHref: string | undefined, filePath: string): string | null;
export declare function getMarkdownPreviewImageSrc(rawSrc: string | undefined, filePath: string): string | undefined;
/**
 * Resolves a relative image src against the markdown file path to produce an
 * absolute filesystem path. Returns null for external URLs (http, https, data,
 * blob) that don't need local file loading.
 */
export declare function resolveImageAbsolutePath(rawSrc: string | undefined, filePath: string): string | null;
