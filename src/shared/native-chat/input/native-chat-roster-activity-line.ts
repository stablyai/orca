const ACTIVITY_LIMIT = 160

/** One sheet line. A sealed Codex spawn blob is not activity. */
export function nativeChatRosterActivityLine(text: string): string | null {
  const raw =
    text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  if (!raw || isSealedActivity(raw)) {
    return null
  }
  const line = raw.replace(/\s+/g, ' ').trim()
  return line.length > ACTIVITY_LIMIT ? `${line.slice(0, ACTIVITY_LIMIT - 1)}…` : line
}

function isSealedActivity(line: string): boolean {
  return line.startsWith('gAAAA') || (line.length > 80 && !/\s/.test(line))
}
