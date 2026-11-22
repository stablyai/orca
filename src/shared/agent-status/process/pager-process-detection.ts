// A pager owning the foreground is a known non-agent: `claude --help | less` keeps the agent's name
// in a retained shell title while the live process can never draw a composer (STA-14925).
const PAGER_NAMES = new Set(['less', 'more', 'most', 'pg'])
const PROCESS_EXTENSION_RE = /\.(?:exe|com|cmd|bat)$/i

export function isPagerProcess(processName: string | null | undefined): boolean {
  if (!processName) {
    return false
  }
  const unquoted = processName.trim().replace(/^["']|["']$/g, '')
  const basename = unquoted.split(/[\\/]/).pop() ?? unquoted
  return PAGER_NAMES.has(basename.toLowerCase().replace(PROCESS_EXTENSION_RE, ''))
}
