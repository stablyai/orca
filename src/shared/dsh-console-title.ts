/** DSH's named static title and Orca's owner-qualified display titles. */
export function isDshConsoleTitle(title: string): boolean {
  return /^(?:[\u2800-\u28ff]+\s+)?DSH Console(?: ready| - action required| \([^\r\n]*\))?$/i.test(
    title.trim()
  )
}

export function getDshConsoleTitleStatus(title: string): 'working' | 'permission' | 'idle' | null {
  if (!isDshConsoleTitle(title)) {
    return null
  }
  if (/action required$/i.test(title)) {
    return 'permission'
  }
  if (/^[\u2800-\u28ff]/.test(title.trim())) {
    return 'working'
  }
  return / ready$/i.test(title) ? 'idle' : null
}
