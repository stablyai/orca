import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../shared/ai-vault-types'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export const AI_VAULT_SESSION_DRAG_TYPE = 'application/x-orca-ai-vault-session'
export const AI_VAULT_SESSION_DRAG_START_EVENT = 'orca-ai-vault-session-drag-start'
export const AI_VAULT_SESSION_DRAG_END_EVENT = 'orca-ai-vault-session-drag-end'
export const AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES = 16 * 1024

export type AiVaultSessionDragPayload = {
  agent: AiVaultAgent
  sessionId: string
  title: string
  command: string
  // Why: drop targets must know where the session file lives (host vs local
  // WSL) to reject SSH panes that cannot reach it.
  sessionFilePath?: string
  sessionExecutionHostId?: ExecutionHostId
  codexHome?: string | null
  // Why: drag/drop resume must preserve planned env mutations/default args, not just the command.
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  realHomeStartup?: {
    command: string
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
  }
}

let activeAiVaultSessionDragPayload: AiVaultSessionDragPayload | null = null

type SerializedAiVaultSessionDragPayload = AiVaultSessionDragPayload & {
  kind: 'ai-vault-session'
  version: 1
}

function isAiVaultAgent(value: unknown): value is AiVaultAgent {
  return typeof value === 'string' && (AI_VAULT_AGENTS as readonly string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

function isEnvDeletionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256)
  )
}

function isLaunchConfig(value: unknown): value is SleepingAgentLaunchConfig {
  if (!value || typeof value !== 'object') {
    return false
  }
  const config = value as Partial<SleepingAgentLaunchConfig>
  return (
    (config.agentCommand === undefined || typeof config.agentCommand === 'string') &&
    typeof config.agentArgs === 'string' &&
    isStringRecord(config.agentEnv) &&
    (config.ompResumeFilePath === undefined || isNonEmptyString(config.ompResumeFilePath))
  )
}

function isSerializedPayload(value: unknown): value is SerializedAiVaultSessionDragPayload {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Partial<SerializedAiVaultSessionDragPayload>
  return (
    payload.kind === 'ai-vault-session' &&
    payload.version === 1 &&
    isAiVaultAgent(payload.agent) &&
    isNonEmptyString(payload.sessionId) &&
    isNonEmptyString(payload.title) &&
    isNonEmptyString(payload.command) &&
    (payload.sessionFilePath === undefined || isNonEmptyString(payload.sessionFilePath)) &&
    (payload.sessionExecutionHostId === undefined ||
      Boolean(normalizeExecutionHostId(payload.sessionExecutionHostId))) &&
    (payload.codexHome === undefined ||
      payload.codexHome === null ||
      isNonEmptyString(payload.codexHome)) &&
    (payload.env === undefined || isStringRecord(payload.env)) &&
    (payload.envToDelete === undefined || isEnvDeletionList(payload.envToDelete)) &&
    (payload.launchConfig === undefined || isLaunchConfig(payload.launchConfig)) &&
    (payload.realHomeStartup === undefined || isResumeStartup(payload.realHomeStartup))
  )
}

function isResumeStartup(
  value: unknown
): value is NonNullable<AiVaultSessionDragPayload['realHomeStartup']> {
  if (!value || typeof value !== 'object') {
    return false
  }
  const startup = value as NonNullable<AiVaultSessionDragPayload['realHomeStartup']>
  return (
    isNonEmptyString(startup.command) &&
    (startup.env === undefined || isStringRecord(startup.env)) &&
    (startup.envToDelete === undefined || isEnvDeletionList(startup.envToDelete)) &&
    (startup.launchConfig === undefined || isLaunchConfig(startup.launchConfig))
  )
}

export function writeAiVaultSessionDragData(
  dataTransfer: DataTransfer,
  payload: AiVaultSessionDragPayload
): void {
  const serialized = JSON.stringify({ kind: 'ai-vault-session', version: 1, ...payload })
  if (isAiVaultSessionDragPayloadTooLarge(serialized)) {
    activeAiVaultSessionDragPayload = null
    dataTransfer.effectAllowed = 'copy'
    dataTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')
    return
  }
  activeAiVaultSessionDragPayload = { ...payload }
  dataTransfer.effectAllowed = 'copy'
  // Why: avoid text/plain so terminal/native drop targets cannot paste the
  // resume command instead of letting Orca's pane drop layer handle it.
  dataTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, serialized)
}

export function hasAiVaultSessionDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(AI_VAULT_SESSION_DRAG_TYPE)
}

export function clearAiVaultSessionDragData(): void {
  activeAiVaultSessionDragPayload = null
}

export function readAiVaultSessionDragData(
  dataTransfer: DataTransfer
): AiVaultSessionDragPayload | null {
  const raw = dataTransfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  if (!raw) {
    return hasAiVaultSessionDragData(dataTransfer) ? activeAiVaultSessionDragPayload : null
  }
  if (isAiVaultSessionDragPayloadTooLarge(raw)) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isSerializedPayload(parsed)) {
      return null
    }
    const {
      agent,
      sessionId,
      title,
      command,
      sessionFilePath,
      sessionExecutionHostId,
      codexHome,
      env,
      envToDelete,
      launchConfig,
      realHomeStartup
    } = parsed
    return {
      agent,
      sessionId,
      title,
      command,
      ...(sessionFilePath ? { sessionFilePath } : {}),
      ...(sessionExecutionHostId ? { sessionExecutionHostId } : {}),
      ...(codexHome !== undefined ? { codexHome } : {}),
      ...(env ? { env } : {}),
      ...(envToDelete ? { envToDelete } : {}),
      ...(launchConfig ? { launchConfig } : {}),
      ...(realHomeStartup ? { realHomeStartup } : {})
    }
  } catch {
    return null
  }
}

function isAiVaultSessionDragPayloadTooLarge(raw: string): boolean {
  return (
    raw.length > AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES ||
    measureClipboardTextByteLength(raw, {
      stopAfterBytes: AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
    }).exceededLimit
  )
}
