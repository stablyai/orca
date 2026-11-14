import { originalPluginPosition } from './declarative-source-maps'

/** Mirrors PLUGIN_FRAME_RESERVED_SEGMENT: Orca's own files (this runtime) are never the culprit. */
export const ORCA_RESERVED_PATH_PREFIX = '/__orca/'

const STACK_FRAME_URL = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/i
// A transpile or import error module already names `file:line:column`; its `throw` frame is noise.
const LOCATED_MESSAGE = /^[^\n:]+\.[a-z]+:\d+:\d+: /i

function pageBase(): string | null {
  return typeof location === 'undefined' ? null : new URL('/', location.href).href
}

type PluginFrame = { path: string; line: number; column: number }

/** The plugin file a stack line runs in, at its source position; null for Orca's or foreign code. */
function pluginFrame(stackLine: string, base: string): PluginFrame | 'orca' | null {
  const match = STACK_FRAME_URL.exec(stackLine)
  const url = match?.[1]
  if (!match || !url?.startsWith(base)) {
    return null
  }
  const path = `/${url.slice(base.length).split(/[?#]/)[0] ?? ''}`
  if (path.startsWith(ORCA_RESERVED_PATH_PREFIX)) {
    return 'orca'
  }
  const generated = { line: Number(match[2]), column: Number(match[3]) }
  const at = originalPluginPosition(url, generated.line, generated.column) ?? generated
  try {
    return { path: decodeURIComponent(path.slice(1)), ...at }
  } catch {
    return { path: path.slice(1), ...at }
  }
}

const formatFrame = (frame: PluginFrame): string => `${frame.path}:${frame.line}:${frame.column}`

/** `path:line:column` of the first stack frame in one of the plugin's own files. */
export function pluginErrorLocation(stack: string, base: string): string | null {
  for (const line of stack.split('\n')) {
    const frame = pluginFrame(line, base)
    if (frame && frame !== 'orca') {
      return formatFrame(frame)
    }
  }
  return null
}

/**
 * The error's message, prefixed with where in the plugin it was thrown, at the source position
 * (as `orca plugin check` reports it); a message that already names its file is kept.
 */
export function describePluginError(error: unknown, base = pageBase()): string {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const at = base && !LOCATED_MESSAGE.test(message) ? pluginErrorLocation(stack, base) : null
  if (!at) {
    return message
  }
  const file = at.replace(/:\d+:\d+$/, '')
  return message.startsWith(`${file}:`) ? message : `${at}: ${message}`
}

/**
 * What `orca plugin logs` shows: the located message, then the stack's frames at source positions
 * with Orca's runtime frames left out. A message that already names its location stands alone.
 */
export function describePluginErrorForLog(error: unknown, base = pageBase()): string {
  const headline = describePluginError(error, base)
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  if (!base || LOCATED_MESSAGE.test(message)) {
    return base ? headline : stack || headline
  }
  const frames = stack.split('\n').flatMap((line) => {
    if (!/^\s+at /.test(line)) {
      return []
    }
    const frame = pluginFrame(line, base)
    if (frame === 'orca') {
      return []
    }
    const closing = line.trimEnd().endsWith(')') ? ')' : ''
    return [frame ? line.replace(STACK_FRAME_URL, () => `${formatFrame(frame)}${closing}`) : line]
  })
  return [headline, ...frames].join('\n')
}
