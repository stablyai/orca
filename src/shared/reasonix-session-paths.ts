import { isRuntimePathAbsolute } from './cross-platform-path'

export type ReasonixSessionLayout = {
  stateHome: string
  projectDirectory: string
  sessionDirectory: string
  sessionId: string
}

// Stable 1.39.7 native storage identity rules, including Windows reserved names.
export function isReasonixStorageSessionId(value: string): boolean {
  const bytes = new TextEncoder().encode(value).length
  return (
    value.trim() === value &&
    bytes > 0 &&
    bytes <= 255 &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    ![...value].some((character) => character.charCodeAt(0) < 0x20) &&
    !/[/\\<>:"|?*]/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
  )
}

// Preserve execution-host spelling; never reverse a lossy project slug into cwd.
export function reasonixSessionLayout(path: string): ReasonixSessionLayout | null {
  if (
    !isRuntimePathAbsolute(path) ||
    path.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')
  ) {
    return null
  }
  const match = path.match(
    /^(.*)[\\/]projects[\\/]([^\\/]+)[\\/]sessions-v4[\\/]([^\\/]+)[\\/]events\.frames$/
  )
  if (!match || match[2] === '.' || match[2] === '..' || !isReasonixStorageSessionId(match[3])) {
    return null
  }
  let stateHome = match[1]
  if (!stateHome) {
    stateHome = path.startsWith('/') ? '/' : '\\'
  } else if (/^[A-Za-z]:$/.test(stateHome)) {
    stateHome += path[2]
  }
  const sessionDirectory = path.replace(/[\\/]events\.frames$/, '')
  const projectDirectory = sessionDirectory.replace(/[\\/]sessions-v4[\\/][^\\/]+$/, '')
  return { stateHome, projectDirectory, sessionDirectory, sessionId: match[3] }
}
