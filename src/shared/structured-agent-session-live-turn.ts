// Scan the newest turn’s own work, stopping at its typed/legacy turn record; child output never describes the root agent.
// Read turn records before producer filters only because turn rows carry no linkage: Claude/Codex primary turns, compact fences,
// and stale/dead-generation revisions all preserve that invariant. Recheck before adding producers to any turn-writing site.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnScope
} from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentSessionLatestTurn, AgentSessionSubscribeEvent } from './agent-session-wire'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { isAgentSessionContextClear } from './agent-session-context-clear'
import type { NativeChatToolCallBlock } from './native-chat-types'
import {
  isRunningStructuredAgentSessionToolAction,
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock,
  type StructuredAgentSessionToolAction
} from './structured-agent-session-tool-call-block'

/** Host current-work scope excludes turns from ended generations. */
export function activeStructuredAgentSessionTurnId(
  items: readonly AgentJournalRenderItem[],
  current?: (item: AgentJournalRenderItem) => boolean
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (isAgentSessionContextClear(item?.body)) {
      return null
    }
    const turn = readAgentJournalTurn(item?.body)
    if (turn) {
      return turn.state === 'running' && (!current || (item && current(item))) ? turn.turnId : null
    }
  }
  return null
}

/** Read unordered items by sequence; ties choose the later-reduced item, matching stable render sort. */
export function newestStructuredAgentSessionTurnBySequence(
  items: Iterable<AgentJournalRenderItem>
): AgentJournalTurnLifecycle | null {
  let newestSequence = 0
  let newest: AgentJournalTurnLifecycle | null = null
  for (const item of items) {
    if (item.sequence < newestSequence) {
      continue
    }
    if (isAgentSessionContextClear(item.body)) {
      newestSequence = item.sequence
      newest = null
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      newestSequence = item.sequence
      newest = turn
    }
  }
  return newest
}

/** For unordered items, new rows join the running turn or the conversation if none runs. */
export function liveStructuredAgentSessionTurnScope(
  items: Iterable<AgentJournalRenderItem>
): AgentJournalTurnScope {
  const running = runningStructuredAgentSessionTurnItemBySequence(items)
  return running ? { kind: 'turn', turnItemId: running.item.itemId } : AGENT_JOURNAL_THREAD_SCOPE
}

export function runningStructuredAgentSessionTurnItemBySequence(
  items: Iterable<AgentJournalRenderItem>
): { item: AgentJournalRenderItem; turnId: string } | null {
  let newest: AgentJournalRenderItem | null = null
  for (const item of items) {
    if (
      (newest === null || item.sequence >= newest.sequence) &&
      (readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body))
    ) {
      newest = item
    }
  }
  const turn = newest ? readAgentJournalTurn(newest.body) : null
  return newest && turn?.state === 'running' ? { item: newest, turnId: turn.turnId } : null
}

/** Include ended state: restart resume must distinguish interrupted from finished turns, and eviction settles to interrupted.
 * Rendered snapshots are already ordered; use the by-sequence reader for unordered items. */
export function newestStructuredAgentSessionTurn(
  items: readonly AgentJournalRenderItem[]
): AgentJournalTurnLifecycle | null {
  return latestStructuredAgentSessionTurn(items)?.turn ?? null
}

export function latestStructuredAgentSessionTurn(
  items: readonly AgentJournalRenderItem[]
): AgentSessionLatestTurn | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (isAgentSessionContextClear(item?.body)) {
      return null
    }
    const turn = readAgentJournalTurn(item?.body)
    if (item && turn) {
      return { itemId: item.itemId, observedAt: item.observedAt, turn }
    }
  }
  return null
}

/** Prefer whole-journal host turn state; Temporary: retain loaded-row fallback until hosts omitting latestTurn age out. */
export function runningStructuredAgentSessionTurnId(state: HostTurnSource): string | null {
  if (state.latestTurn === undefined) {
    return activeStructuredAgentSessionTurnId(state.items)
  }
  return state.latestTurn?.turn.state === 'running' ? state.latestTurn.turn.turnId : null
}

export function runningStructuredAgentSessionTurnScope(
  state: HostTurnSource
): AgentJournalTurnScope {
  if (state.latestTurn === undefined) {
    return liveStructuredAgentSessionTurnScope(state.items)
  }
  return state.latestTurn?.turn.state === 'running'
    ? { kind: 'turn', turnItemId: state.latestTurn.itemId }
    : AGENT_JOURNAL_THREAD_SCOPE
}

type HostTurnSource = {
  items: readonly AgentJournalRenderItem[]
  latestTurn?: AgentSessionLatestTurn | null
}

/** Row-carrying batches restate latestTurn; missing fields mean older host, so drop stale claims and derive from rows. */
export function latestTurnAfterStructuredAgentSessionBatch(
  previous: AgentSessionLatestTurn | null | undefined,
  event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
): AgentSessionLatestTurn | null | undefined {
  const { items, removedItemIds, submissions } = event.batch
  const carriesRows = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  return carriesRows || event.latestTurn !== undefined ? event.latestTurn : previous
}

/** Row-carrying batches restate actionable prompts; missing fields from older hosts clear prior claims. */
export function actionablePromptIdsAfterStructuredAgentSessionBatch(
  previous: string[] | undefined,
  event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
): string[] | undefined {
  const { items, removedItemIds, submissions } = event.batch
  const carriesRows = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  return carriesRows || event.actionablePromptIds !== undefined
    ? event.actionablePromptIds
    : previous
}

/** Apply the same row-carrying/older-host reset rule as latestTurn. */
export function hostWorkingAfterStructuredAgentSessionBatch(
  previous: boolean | undefined,
  event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
): boolean | undefined {
  const { items, removedItemIds, submissions } = event.batch
  const carriesRows = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  return carriesRows || event.working !== undefined ? event.working : previous
}

/** Host work can change at generation end without any row; changed turn/prompt/working facts must prevent no-op reduction. */
export function restatesStructuredAgentSessionHostWork(
  event: Pick<
    Extract<AgentSessionSubscribeEvent, { type: 'batch' }>,
    'latestTurn' | 'actionablePromptIds' | 'working'
  >,
  state: {
    latestTurn?: AgentSessionLatestTurn | null
    actionablePromptIds?: string[]
    working?: boolean
  }
): boolean {
  return (
    (event.latestTurn === undefined ||
      JSON.stringify(event.latestTurn) === JSON.stringify(state.latestTurn)) &&
    (event.actionablePromptIds === undefined ||
      event.actionablePromptIds.join('\n') === state.actionablePromptIds?.join('\n')) &&
    (event.working === undefined || event.working === state.working)
  )
}

/** Prefer host work facts; older hosts require derivation from loaded rows. */
export function structuredAgentSessionHostSaysWorking(
  hostWorking: boolean | undefined,
  derived: () => boolean
): boolean {
  return hostWorking ?? derived()
}

/** Working through the gap between turn end/Resume and the host's next queued-send update. */
export function structuredAgentSessionQueueSendsNext(
  nextQueuedMessageId: string | null | undefined,
  isWorking: boolean
): boolean {
  return nextQueuedMessageId != null && !isWorking
}

/** Use host-named actionable prompts; older hosts treat every pending prompt as waiting. */
export function isActionableStructuredAgentSessionPrompt(
  itemId: string,
  actionablePromptIds: readonly string[] | undefined
): boolean {
  return actionablePromptIds === undefined || actionablePromptIds.includes(itemId)
}

/** Thinking means current reasoning, not merely waiting for first output; tool arrival can precede further reasoning. */
export function isStructuredAgentSessionThinking({ items, latestTurn }: HostTurnSource): boolean {
  // Host state outranks a loaded turn whose ending revision may be outside the window.
  const hostRunning = latestTurn === undefined ? null : latestTurn?.turn.state === 'running'
  let newestContentIsReasoning: boolean | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    if (isAgentSessionContextClear(body)) {
      return false
    }
    const turn = readAgentJournalTurn(body)
    if (turn) {
      return (hostRunning ?? turn.state === 'running') && newestContentIsReasoning === true
    }
    if (newestContentIsReasoning !== null || !isRootAgentJournalItem(item)) {
      continue
    }
    if (body?.kind === 'message') {
      // Ended reasoning is not current; old hosts may omit message state.
      newestContentIsReasoning =
        body.role === 'reasoning' && (body.state === undefined || body.state === 'running')
    } else if (
      body?.kind === 'tool-call' ||
      body?.kind === 'diff' ||
      body?.kind === 'approval' ||
      body?.kind === 'question'
    ) {
      newestContentIsReasoning = false
    }
  }
  // Turn record predates the loaded window, so all loaded root content is newer.
  return hostRunning === true && newestContentIsReasoning === true
}

/** Root agent’s newest running tool, else newest settled tool, only inside a running turn.
 * Keep the line through tool completion; mid-turn user sends are not turn boundaries. */
export function statusStructuredAgentSessionToolCall(
  items: readonly AgentJournalRenderItem[]
): NativeChatToolCallBlock | null {
  let newest: { action: StructuredAgentSessionToolAction; itemId: string } | null = null
  let running: { action: StructuredAgentSessionToolAction; itemId: string } | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item) {
      continue
    }
    const body = item.body
    if (isAgentSessionContextClear(body)) {
      return null
    }
    const turn = readAgentJournalTurn(body)
    if (turn) {
      const named = turn.state === 'running' ? (running ?? newest) : null
      // Project only the winning tool; the host repeats this read on every journal change.
      return named ? structuredAgentSessionToolCallBlock(named.action, named.itemId) : null
    }
    if (running || !isStructuredAgentSessionToolAction(body) || !isRootAgentJournalItem(item)) {
      continue
    }
    newest ??= { action: body, itemId: item.itemId }
    if (isRunningStructuredAgentSessionToolAction(body)) {
      running = { action: body, itemId: item.itemId }
    }
  }
  return null
}
