// Why: dropped image files should be handed to terminal TUIs (Claude Code,
// Codex, etc.) as image attachments, which those tools detect from a
// *bracketed paste* of the file path — exactly how clipboard screenshot paste
// already works in Orca (see terminal-clipboard-paste.ts + issue #2842). To
// decide which dropped paths get that treatment we need a cheap, shell-agnostic
// image-extension check. The extension set mirrors IMAGE_MIME_TYPES in
// src/relay/fs-handler-utils.ts so "what Orca considers an image" stays
// consistent across the app.
const IMAGE_DROP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.ico'
])

/**
 * Returns true when `path` looks like a local/remote image file based on its
 * extension. Handles POSIX (`/`) and Windows (`\`) separators and is
 * case-insensitive. The extension must be part of the basename, so directory
 * components with dots (e.g. `/home/jane.doe/photo`) are not misclassified.
 */
export function isImageDropPath(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot === -1) {
    return false
  }
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastDot < lastSeparator) {
    return false
  }
  return IMAGE_DROP_EXTENSIONS.has(path.slice(lastDot).toLowerCase())
}
