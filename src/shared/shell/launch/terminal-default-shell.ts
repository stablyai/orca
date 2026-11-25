/** Stored form of the Terminal shell setting; launches read it raw, so it must never carry padding. '' = system shell. */
export function normalizeTerminalDefaultShell(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
