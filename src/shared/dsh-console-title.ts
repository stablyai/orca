/** DSH's named static title and Orca's owner-qualified display titles. */
export function isDshConsoleTitle(title: string): boolean {
  return /^(?:[\u2800-\u28ff]+\s+)?DSH Console(?: ready| - action required| \([^\r\n]*\))?$/i.test(
    title.trim()
  )
}

export function getDshConsoleTitleStatus(title: string): 'working' | 'permission' | 'idle' | null {
  const normalizedTitle = title.trim()
  if (!isDshConsoleTitle(normalizedTitle)) {
    return null
  }
  if (/action required$/i.test(normalizedTitle)) {
    return 'permission'
  }
  if (/^[\u2800-\u28ff]/.test(normalizedTitle)) {
    return 'working'
  }
  return / ready$/i.test(normalizedTitle) ? 'idle' : null
}
