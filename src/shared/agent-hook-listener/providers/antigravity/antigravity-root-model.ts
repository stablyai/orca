import { join } from 'node:path'
import { readPathFromKeys } from '../../../agent-session/lifecycle/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../agent-status/contracts/agent-status-freshness'
import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import { readFirstString } from '../../interactive-tool'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import type { JsonlCursor } from '../codex/codex-rollout-jsonl-format'
import type { AntigravityTranscriptOrigin } from './antigravity-hook-identity'

export type AntigravityTranscriptModel = { model: string; at: number; step?: number }

export type AntigravityLeadModelFence = { since: number; fromStep?: number }

export type AntigravityRootModel = {
  conversationId: string
  cursor: JsonlCursor
  transcriptModel?: AntigravityTranscriptModel
  observedAt: number
  leadModel?: string
  explicitModel?: true
  fence?: AntigravityLeadModelFence
}

export function normalizeAntigravityModel(raw: unknown): string | undefined {
  const normalized = normalizeOptionalField(raw, AGENT_MODEL_MAX_LENGTH)
  return normalized && normalized.toLowerCase() !== 'auto' ? normalized : undefined
}

export function observeAntigravityRootModel(
  previous: AntigravityRootModel | undefined,
  {
    conversationId,
    transcriptPath,
    hookPayload,
    origin,
    resetsTurn,
    replayReceivedAt
  }: {
    conversationId?: string
    transcriptPath?: string
    hookPayload: Record<string, unknown>
    origin: AntigravityTranscriptOrigin
    resetsTurn: boolean
    replayReceivedAt?: number
  }
): AntigravityRootModel | undefined {
  if (!conversationId || origin === 'child') {
    return undefined
  }
  const current = previous?.conversationId === conversationId ? previous : undefined
  if (!current && origin !== 'root' && !readFirstString(hookPayload, ['lastUserInput'])) {
    return undefined
  }
  const artifact = readPathFromKeys(hookPayload, [
    'artifactDirectoryPath',
    'artifact_directory_path'
  ])
  const filePath =
    transcriptPath ??
    current?.cursor.filePath ??
    (artifact ? join(artifact, '.system_generated', 'logs', 'transcript.jsonl') : undefined)
  const now = Date.now()
  const observedAt = Math.min(replayReceivedAt ?? now, now)
  const model =
    current && current.cursor.filePath === filePath
      ? current
      : {
          ...current,
          conversationId,
          cursor: { filePath, offset: 0, carry: '' },
          transcriptModel: undefined,
          observedAt
        }
  model.observedAt = Math.max(model.observedAt, observedAt)
  const raw = readFirstString(hookPayload, ['modelName', 'model'])
  const resolved = normalizeAntigravityModel(raw)
  if (resolved) {
    model.leadModel = resolved
    model.explicitModel = true
    model.fence = undefined
  } else if (!current || (resetsTurn && (raw || !model.explicitModel))) {
    model.explicitModel = undefined
    model.fence = {
      since: observedAt,
      fromStep:
        typeof hookPayload.initialNumSteps === 'number' ? hookPayload.initialNumSteps : undefined
    }
  }
  return model
}

export function antigravityModelReadEndsAt(root: AntigravityRootModel): number {
  return root.observedAt + AGENT_STATUS_STALE_AFTER_MS
}

export function antigravityModelPollOwner(
  state: HookListenerState,
  row: AgentHookEventPayload
): AntigravityRootModel | undefined {
  const root = state.antigravityChildWorkByPaneKey.get(row.paneKey)?.rootModel
  const session =
    row.statusAdmissionSession ?? row.providerSession?.id ?? row.agentPresence?.session
  return root?.fence &&
    root.cursor.filePath &&
    row.payload.agentType === 'antigravity' &&
    row.payload.state !== 'done' &&
    row.connectionId === null &&
    !row.providerSessionOnly &&
    !row.agentPresence?.ended &&
    (!session || session === root.conversationId) &&
    Date.now() < antigravityModelReadEndsAt(root)
    ? root
    : undefined
}
