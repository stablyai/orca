// Rules both OSC 7 parsers (the daemon's and the renderer's) share, so they agree on a folder.

/** A `%` not followed by two hex digits is a literal `%` (nushell sends folder names unencoded). */
export function escapeLiteralPercent(text: string): string {
  return text.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
}

/**
 * No path can contain NUL, and node-pty silently truncates a cwd at one while execFile can throw;
 * refusing keeps the last good folder. Other control characters are legal in folder names.
 */
export function hasNulCharacter(path: string): boolean {
  return path.includes('\0')
}
