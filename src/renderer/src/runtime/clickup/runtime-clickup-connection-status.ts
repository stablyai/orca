import type {
  ClickUpConnectionStatus,
  ClickUpViewer,
  ClickUpWorkspace
} from '../../../../shared/clickup/clickup-types'
import type { SecretAtRestProtection } from '../../../../shared/secure-storage/secret-at-rest-protection'

// Coverage record: tsc fails when the shared union gains or loses an arm.
const SECRET_AT_REST_PROTECTIONS = { sealed: true, plaintext: true } as const satisfies Readonly<
  Record<SecretAtRestProtection, true>
>

// Every key must be listed, so a newly added field cannot be dropped silently.
type EveryKey<T> = { [K in keyof Required<T>]: T[K] }

export const DISCONNECTED_CLICKUP_STATUS: ClickUpConnectionStatus = {
  connected: false,
  viewer: null,
  workspaces: [],
  selectedWorkspaceId: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSecretAtRestProtection(value: unknown): value is SecretAtRestProtection {
  return typeof value === 'string' && Object.hasOwn(SECRET_AT_REST_PROTECTIONS, value)
}

function parseClickUpViewer(value: unknown): ClickUpViewer | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.email !== 'string'
  ) {
    return null
  }
  const viewer: EveryKey<ClickUpViewer> = {
    id: value.id,
    username: value.username,
    email: value.email,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : undefined
  }
  return viewer
}

function parseClickUpWorkspaces(value: unknown): ClickUpWorkspace[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry): ClickUpWorkspace[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      return []
    }
    const workspace: EveryKey<ClickUpWorkspace> = {
      id: entry.id,
      name: entry.name,
      color: typeof entry.color === 'string' ? entry.color : undefined
    }
    return [workspace]
  })
}

// Why: a missing reply (the paired web client's fallback) or a malformed field from another host version must not crash readers or hide a real connection.
export function parseClickUpConnectionStatus(value: unknown): ClickUpConnectionStatus {
  if (!isRecord(value) || typeof value.connected !== 'boolean') {
    return DISCONNECTED_CLICKUP_STATUS
  }
  const status: EveryKey<ClickUpConnectionStatus> = {
    connected: value.connected,
    viewer: parseClickUpViewer(value.viewer),
    workspaces: parseClickUpWorkspaces(value.workspaces),
    selectedWorkspaceId:
      typeof value.selectedWorkspaceId === 'string' ? value.selectedWorkspaceId : null,
    credentialError: typeof value.credentialError === 'string' ? value.credentialError : undefined,
    credentialProtection:
      value.credentialProtection === null || isSecretAtRestProtection(value.credentialProtection)
        ? value.credentialProtection
        : undefined
  }
  return status
}
