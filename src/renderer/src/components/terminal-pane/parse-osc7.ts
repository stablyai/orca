// xterm strips OSC 7 framing; the payload is a file:// URI reporting the shell’s current directory.

const OSC7_URI = /^file:\/\/([^/]*)(\/.*)$/

type ParseOsc7Options = {
  uncHost?: string | null
}

/**
 * Parse an OSC 7 payload and return the decoded path, or null if the payload
 * is not a file URI we recognize. Returns the path a `cwd` option of
 * `child_process.spawn` / `node-pty` would accept on the current platform.
 */
export function parseOsc7(data: string, options: ParseOsc7Options = {}): string | null {
  const match = OSC7_URI.exec(data)
  if (!match) {
    return null
  }
  const host = match[1]
  let path: string
  try {
    path = decodeURIComponent(match[2])
  } catch {
    return null
  }
  if (!path) {
    return null
  }
  const isWindowsDrivePath = /^\/[A-Za-z]:/.test(path)
  if (options.uncHost && !isWindowsDrivePath) {
    // Only the launch UNC server is a known Windows file host; other hosts may name POSIX shells.
    if (host.toLowerCase() === options.uncHost.toLowerCase()) {
      return `\\\\${host}${path.replace(/\//g, '\\')}`
    }
  }
  // Strip the URI’s leading slash from drive paths; sandboxed renderers lack process.platform, so detect Windows paths by shape.
  if (isWindowsDrivePath) {
    path = path.slice(1)
  }
  return path
}
