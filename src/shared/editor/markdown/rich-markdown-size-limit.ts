/** ProseMirror mounts whole documents. M-series Electron measurements at 300/450/600KB: longest tasks 0.66/1.02/1.41s; 600KB typing p95 39ms (#17134/#17147/#17158). Use cheap pre-parse byte guard, then source mode with Open anyway. */
export const RICH_MARKDOWN_MAX_SIZE_BYTES = 600 * 1024
