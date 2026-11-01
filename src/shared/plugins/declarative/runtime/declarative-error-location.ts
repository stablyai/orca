/** Mirrors PLUGIN_FRAME_RESERVED_SEGMENT: Orca's own files (this runtime) are never the culprit. */
export const ORCA_RESERVED_PATH_PREFIX = '/__orca/'

const STACK_FRAME_URL = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/i

function pageBase(): string | null {
  return typeof location === 'undefined' ? null : new URL('/', location.href).href
}

/** `path:line:column` of the first stack frame in one of the plugin's own files. */
export function pluginErrorLocation(stack: string, base: string): string | null {
  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_URL.exec(line)
    const url = match?.[1]
    if (!match || !url?.startsWith(base)) {
      continue
    }
    const path = `/${url.slice(base.length).split(/[?#]/)[0] ?? ''}`
    if (path.startsWith(ORCA_RESERVED_PATH_PREFIX)) {
      continue
    }
    try {
      return `${decodeURIComponent(path.slice(1))}:${match[2]}:${match[3]}`
    } catch {
      return `${path.slice(1)}:${match[2]}:${match[3]}`
    }
  }
  return null
}

/**
 * The error's message, prefixed with where in the plugin it was thrown. Lines are the source's
 * (transpiling keeps them); a message that already names its file (a transpile error) is kept.
 */
export function describePluginError(error: unknown, base = pageBase()): string {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const at = base ? pluginErrorLocation(stack, base) : null
  if (!at) {
    return message
  }
  const file = at.replace(/:\d+:\d+$/, '')
  return message.startsWith(`${file}:`) ? message : `${at}: ${message}`
}
