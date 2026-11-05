import { join } from 'node:path'

export const SERVE_UPDATE_HANDOFF_PATH_ENV = 'ORCA_SERVE_UPDATE_HANDOFF_PATH'
export const SERVE_UPDATE_HANDOFF_FILE = 'serve-update-handoff.json'

export type ServeUpdateHandoffState =
  | {
      schemaVersion: 1
      phase: 'install-requested'
      fromVersion: string
      targetVersion: string
      servingPid: number
    }
  | {
      schemaVersion: 1
      phase: 'failed'
      fromVersion: string
      targetVersion: string
      servingPid: number
      reason: string
    }
  | {
      schemaVersion: 1
      phase: 'completed'
      fromVersion: string
      targetVersion: string
      servingPid: number
      runtimeId: string
    }

export type ServeSupervisorMessage = {
  type: 'orca:serve-ready'
  version: string
  runtimeId: string
}

export function getServeUpdateHandoffPath(userDataPath: string): string {
  return join(userDataPath, SERVE_UPDATE_HANDOFF_FILE)
}

export function parseServeUpdateHandoffState(value: unknown): ServeUpdateHandoffState | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  if (
    state.schemaVersion !== 1 ||
    !['install-requested', 'failed', 'completed'].includes(String(state.phase)) ||
    typeof state.fromVersion !== 'string' ||
    state.fromVersion.length === 0 ||
    typeof state.targetVersion !== 'string' ||
    state.targetVersion.length === 0 ||
    !Number.isInteger(state.servingPid) ||
    (state.servingPid as number) <= 0 ||
    (state.phase === 'failed' && typeof state.reason !== 'string') ||
    (state.phase === 'completed' &&
      (typeof state.runtimeId !== 'string' || state.runtimeId.length === 0))
  ) {
    return null
  }
  return state as ServeUpdateHandoffState
}

export function parseServeSupervisorMessage(value: unknown): ServeSupervisorMessage | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const message = value as Record<string, unknown>
  if (
    message.type !== 'orca:serve-ready' ||
    typeof message.version !== 'string' ||
    message.version.length === 0 ||
    typeof message.runtimeId !== 'string' ||
    message.runtimeId.length === 0
  ) {
    return null
  }
  return message as ServeSupervisorMessage
}
