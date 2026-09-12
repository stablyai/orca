const ATOMCODE_IDLE = '\u{1F7E2}' // 🟢
const ATOMCODE_WORKING = '\u{1F7E1}' // 🟡
const ATOMCODE_PERMISSION = '\u{1F534}' // 🔴

export type AtomCodeTerminalTitleStatus = 'idle' | 'working' | 'permission'

/** AtomCode prefixes its OSC title with a traffic-light glyph that survives task-title changes. */
export function getAtomCodeTerminalTitleStatus(title: string): AtomCodeTerminalTitleStatus | null {
  const trimmed = title.trimStart()
  if (trimmed === ATOMCODE_PERMISSION || trimmed.startsWith(`${ATOMCODE_PERMISSION} `)) {
    return 'permission'
  }
  if (trimmed === ATOMCODE_WORKING || trimmed.startsWith(`${ATOMCODE_WORKING} `)) {
    return 'working'
  }
  if (trimmed === ATOMCODE_IDLE || trimmed.startsWith(`${ATOMCODE_IDLE} `)) {
    return 'idle'
  }
  return null
}

export function isAtomCodeTerminalTitle(title: string): boolean {
  return getAtomCodeTerminalTitleStatus(title) !== null
}
