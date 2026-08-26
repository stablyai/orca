import type { AgentHookSource } from '../agent-hook-relay'
import { parsePaneKey } from '../stable-pane-id'
import { MAX_PANE_KEY_LEN, warnOnHookEnvOrVersionMismatch } from './listener-limits'
import type { HookListenerState } from './listener-state'
import { parseAgentHookJson } from './request-body'
function readEnvelopeString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export type ParsedHookEnvelope = {
  record: Record<string, unknown>
  paneKey: string
  hookPayloadRecord: Record<string, unknown>
  tabId?: string
  worktreeId?: string
  launchToken?: string
}

/** Validates the transport envelope while preserving warning-before-tab-rejection order. */
export function parseHookEnvelope(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string
): ParsedHookEnvelope | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const record = body as Record<string, unknown>
  const paneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const parsedPaneKey = parsePaneKey(paneKey)
  const rawPayload = record.payload
  // Antigravity may carry a transition with absent stdin; every other provider requires payload.
  const antigravityPayloadAbsent =
    source === 'antigravity' &&
    (rawPayload === undefined || (typeof rawPayload === 'string' && rawPayload.trim() === ''))
  const hookPayload = antigravityPayloadAbsent
    ? {}
    : typeof rawPayload === 'string'
      ? (() => {
          try {
            return parseAgentHookJson(rawPayload)
          } catch {
            return null
          }
        })()
      : rawPayload
  if (
    !paneKey ||
    paneKey.length > MAX_PANE_KEY_LEN ||
    !parsedPaneKey ||
    typeof hookPayload !== 'object' ||
    hookPayload === null
  ) {
    return null
  }
  warnOnHookEnvOrVersionMismatch(state, {
    version: readEnvelopeString(record, 'version'),
    env: readEnvelopeString(record, 'env'),
    expectedEnv
  })
  const tabId = readEnvelopeString(record, 'tabId')
  if (tabId && tabId !== parsedPaneKey.tabId) {
    return null
  }
  return {
    record,
    paneKey,
    hookPayloadRecord: hookPayload as Record<string, unknown>,
    tabId,
    worktreeId: readEnvelopeString(record, 'worktreeId'),
    launchToken: readEnvelopeString(record, 'launchToken')
  }
}
