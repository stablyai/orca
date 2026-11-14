import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../wsl-hook-relay-contract'
import { agentProviderSessionsEqual, type SleepingAgentSessionRecord } from './agent-session-resume'

/** Where a hook row's agent ran, as a saved record keeps it: its WSL relay's distro, '' for a
 *  local row, undefined for a row from another host (its `connectionId` says so). */
export function hookConnectionWslDistro(
  connectionId: string | null | undefined
): string | undefined {
  if (connectionId === null) {
    return ''
  }
  return connectionId !== undefined && isWslHookRelayConnectionId(connectionId)
    ? connectionId.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length)
    : undefined
}

/** A status entry's distro: what its relay row named, else the same agent's earlier entry's. */
export function statusEntryWslDistro(
  routed: string | undefined,
  existing: { wslDistro?: string; agentType?: string } | undefined,
  agentType: string | undefined
): { wslDistro?: string } {
  const wslDistro = routed ?? (existing?.agentType === agentType ? existing?.wslDistro : undefined)
  return wslDistro === undefined ? {} : { wslDistro }
}

type SavedConversation = Pick<
  SleepingAgentSessionRecord,
  'agent' | 'providerSession' | 'connectionId' | 'wslDistro'
>

/** What a saved place shows of its conversation, kept apart from how it resumes. */
type SavedSummary = Pick<
  SleepingAgentSessionRecord,
  'lastAssistantMessage' | 'terminalTitle' | 'wslDistro'
>

const SUMMARY_FIELDS = ['lastAssistantMessage', 'terminalTitle', 'wslDistro'] as const

/** One conversation in one execution scope. A distro a writer couldn't tell is no evidence of
 *  another, but two different ones are two conversations. */
function sameSavedConversation(a: SavedConversation, b: SavedConversation): boolean {
  return (
    a.agent === b.agent &&
    agentProviderSessionsEqual(a.agent, a.providerSession, b.providerSession) &&
    (a.connectionId ?? null) === (b.connectionId ?? null) &&
    (a.wslDistro === undefined || b.wslDistro === undefined || a.wslDistro === b.wslDistro)
  )
}

/** `next` with the last reply, title and distro its pane's earlier record of the same
 *  conversation held and `next` doesn't, since a writer replacing a place can lack them (a
 *  sleep capture, a wake, a status with no new reply). Never another conversation's, and never
 *  its state, prompt or launch. `next` itself when there is nothing to keep. */
export function withSavedSummary<T extends SavedConversation & SavedSummary>(
  next: T,
  previous: (SavedConversation & SavedSummary) | undefined
): T {
  if (!previous || previous === next || !sameSavedConversation(previous, next)) {
    return next
  }
  let kept: T | undefined
  for (const field of SUMMARY_FIELDS) {
    if (next[field] === undefined && previous[field] !== undefined) {
      kept = { ...(kept ?? next), [field]: previous[field] }
    }
  }
  return kept ?? next
}

/** A saved map with each record's summary kept from `previous`'s record for its pane; the same
 *  map when nothing is kept, so an unchanged save stays unchanged. */
export function keepSavedAgentSummaries<
  T extends Record<string, SleepingAgentSessionRecord> | undefined
>(previous: Record<string, SleepingAgentSessionRecord> | undefined, next: T): T {
  if (!previous || !next || previous === next) {
    return next
  }
  let kept: Record<string, SleepingAgentSessionRecord> | undefined
  for (const [paneKey, record] of Object.entries(next)) {
    const withSummary = withSavedSummary(record, previous[paneKey])
    if (withSummary !== record) {
      kept ??= { ...next }
      kept[paneKey] = withSummary
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a copy of `next` with only record fields filled in keeps its type.
  return (kept ?? next) as T
}
