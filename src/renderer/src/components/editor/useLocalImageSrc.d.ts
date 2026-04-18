/**
 * Subscribe to cache invalidation events (fired on window re-focus).
 * Returns an unsubscribe function.
 */
export declare function onImageCacheInvalidated(listener: () => void): () => void;
/**
 * Resolves a raw markdown image src to a displayable URL. For local images,
 * reads the file via IPC and returns a blob URL. For http/https/data URLs,
 * returns the URL directly. Re-validates on window re-focus so deleted or
 * replaced images are picked up.
 */
export declare function useLocalImageSrc(rawSrc: string | undefined, filePath: string, connectionId?: string | null): string | undefined;
/**
 * Loads a local image via IPC and returns its blob URL, suitable for use
 * outside React (e.g. ProseMirror nodeViews). Resolves from cache when
 * available.
 */
export declare function loadLocalImageSrc(rawSrc: string, filePath: string, connectionId?: string | null): Promise<string | null>;
