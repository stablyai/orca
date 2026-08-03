const MAX_EVIDENCE_FIELD_LENGTH = 4_096

export const ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV =
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND'
export const ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV = 'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID'
export const ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV =
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION'
export const ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV =
  'ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT'

export type OrchestrationCompatibilityHostStamp =
  | {
      kind: 'wsl'
      hostId: string
      distro: string
    }
  | {
      kind: 'ssh'
      targetId: string
      connectionIncarnation: string
      attachmentId: string
    }

export type OrchestrationCompatibilityEvidence = {
  terminalHandle?: string
  paneKey?: string
  launchToken?: string
  host?: OrchestrationCompatibilityHostStamp
}

const SECRET_KEYS = new Set([
  'launchToken',
  'connectionIncarnation',
  'attachmentId',
  'compatibilityEvidence',
  'orchestrationCompatibilityEvidence',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV
])

function boundedValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= MAX_EVIDENCE_FIELD_LENGTH ? trimmed : undefined
}

export function readOrchestrationCompatibilityEvidence(
  env: Readonly<Record<string, string | undefined>>
): OrchestrationCompatibilityEvidence | undefined {
  const terminalHandle = boundedValue(env.ORCA_TERMINAL_HANDLE)
  const paneKey = boundedValue(env.ORCA_PANE_KEY)
  const launchToken = boundedValue(env.ORCA_AGENT_LAUNCH_TOKEN)
  const host = readHostStamp(env)
  if (!terminalHandle && !paneKey && !launchToken && !host) {
    return undefined
  }
  return {
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(paneKey ? { paneKey } : {}),
    ...(launchToken ? { launchToken } : {}),
    ...(host ? { host } : {})
  }
}

function readHostStamp(
  env: Readonly<Record<string, string | undefined>>
): OrchestrationCompatibilityHostStamp | undefined {
  const kind = boundedValue(env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV])
  const hostId = boundedValue(env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV])
  const incarnation = boundedValue(env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV])
  const attachment = boundedValue(env[ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV])
  if (kind === 'wsl' && hostId && incarnation) {
    return { kind, hostId, distro: incarnation }
  }
  if (kind === 'ssh' && hostId && incarnation && attachment) {
    return {
      kind,
      targetId: hostId,
      connectionIncarnation: incarnation,
      attachmentId: attachment
    }
  }
  return undefined
}

export function redactOrchestrationCompatibilitySecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>())
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (seen.has(value)) {
    return '[circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEYS.has(key) ? '[redacted]' : redactValue(entry, seen)
    ])
  )
}
