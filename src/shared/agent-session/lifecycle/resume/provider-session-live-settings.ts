// Why a shape, not Claude's mode list: a mode a newer Claude adds must still round-trip.
const CLAUDE_PERMISSION_MODE = /^[A-Za-z]{1,32}$/

export function readClaudePermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODE.test(value) ? value : undefined
}
