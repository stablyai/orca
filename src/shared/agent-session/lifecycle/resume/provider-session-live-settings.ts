// Why a shape, not Claude's mode list: a mode a newer Claude adds must still round-trip.
const CLAUDE_PERMISSION_MODE = /^[A-Za-z]{1,32}$/

export function readClaudePermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODE.test(value) ? value : undefined
}

// Why one plain token: the model is replayed onto a restart command line.
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/

export function readClaudeModel(value: unknown): string | undefined {
  return typeof value === 'string' && CLAUDE_MODEL.test(value) ? value : undefined
}

export function readClaudeLiveSettings(record: Record<string, unknown>): {
  permissionMode?: string
  model?: string
} {
  const permissionMode = readClaudePermissionMode(record.permissionMode)
  const model = readClaudeModel(record.model)
  return { ...(permissionMode ? { permissionMode } : {}), ...(model ? { model } : {}) }
}
