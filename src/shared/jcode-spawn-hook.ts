import { MAX_PANE_KEY_LEN } from './agent-hook-listener/listener-limits'
import { isRecord } from './agent-status-child-work-value-guards'
import { isSafeJcodeSessionId } from './jcode-session-files'
import { parsePaneKey } from './stable-pane-id'

export const JCODE_SPAWN_HOOK_ENV_KEY = 'JCODE_SPAWN_HOOK'
export const JCODE_PANE_SECRET_ENV_KEY = 'ORCA_JCODE_PANE_SECRET'
export const JCODE_SPAWN_HOOK_PATHNAME = '/jcode-spawn'
export const JCODE_SPAWN_CREATE_BUDGET_MS = 1000

const MAX_SPAWN_KIND_LEN = 200

export type JcodeSpawnRequest = {
  paneKey: string
  paneSecret: string
  worktreeId?: string
  kind: string
  command: string
  sessionId: string
  coordinatorSessionId?: string
  title?: string
  cwd?: string
  runtimeDir?: string
}

function isRequiredString(value: unknown, cap: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
}

function isOptionalString(value: unknown, cap: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= cap)
}

export function parseJcodeSpawnRequest(body: unknown): JcodeSpawnRequest | null {
  if (
    !isRecord(body) ||
    !isRequiredString(body.paneKey, MAX_PANE_KEY_LEN) ||
    !parsePaneKey(body.paneKey) ||
    !isRequiredString(body.paneSecret, 128) ||
    !isRequiredString(body.kind, MAX_SPAWN_KIND_LEN) ||
    !isRequiredString(body.command, 16 * 1024) ||
    !isRequiredString(body.sessionId, MAX_PANE_KEY_LEN) ||
    !isSafeJcodeSessionId(body.sessionId) ||
    body.sessionId !== body.sessionId.trim() ||
    !isOptionalString(body.worktreeId, MAX_PANE_KEY_LEN) ||
    !isOptionalString(body.coordinatorSessionId, MAX_PANE_KEY_LEN) ||
    (body.coordinatorSessionId !== undefined &&
      body.coordinatorSessionId !== body.coordinatorSessionId.trim()) ||
    !isOptionalString(body.title, 512) ||
    !isOptionalString(body.cwd, 4096) ||
    !isOptionalString(body.runtimeDir, 4096)
  ) {
    return null
  }
  return {
    paneKey: body.paneKey,
    paneSecret: body.paneSecret,
    worktreeId: body.worktreeId || undefined,
    kind: body.kind,
    command: body.command,
    sessionId: body.sessionId,
    coordinatorSessionId: body.coordinatorSessionId || undefined,
    title: body.title || undefined,
    cwd: body.cwd || undefined,
    runtimeDir: body.runtimeDir || undefined
  }
}
