import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField
} from './agent-status-field-normalization'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalToolCallItem
} from './agent-session-journal-types'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import { describeToolInput } from './native-chat-tool-summary'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { sha256 } from './sha256'

function boundedText(payload: { head: string; truncated: boolean; byteLength: number }): string {
  return payload.truncated ? `${payload.head}\n… (${payload.byteLength} bytes)` : payload.head
}

/** The markers a clipped payload carries in its own text, anchored to the end
 *  so nothing that merely looks like one inside the body can match. */
const BOUNDED_TEXT_MARKERS = [
  /\n… \(\d+ bytes\)$/,
  /\n\[Orca: output truncated — \d+ bytes total, digest [0-9a-f]+\]$/
]

/** Recovers the clipped body from a bounded payload's text, and says whether a
 *  marker was there. A reader that treats the text as content renders the
 *  marker as a line of it — with a line number, which reads as a real position
 *  in the file — and reports the body as complete. */
export function stripBoundedTextMarker(text: string): { text: string; truncated: boolean } {
  const stripped = BOUNDED_TEXT_MARKERS.reduce((value, marker) => value.replace(marker, ''), text)
  return { text: stripped, truncated: stripped.length !== text.length }
}

function itemBlocks(item: AgentJournalRenderItem): {
  role: NativeChatMessage['role']
  blocks: NativeChatBlock[]
} | null {
  const body = item.body
  if (body.kind === 'message') {
    return { role: body.role, blocks: body.blocks }
  }
  if (body.kind === 'tool-call') {
    return {
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: body.name,
          input: body.input,
          state: body.state,
          ...(body.callId !== undefined ? { callId: body.callId } : {}),
          ...(body.mcpIdentity !== undefined ? { mcpIdentity: body.mcpIdentity } : {}),
          ...(body.exitCode !== undefined ? { exitCode: body.exitCode } : {}),
          ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
          ...(body.webSearchResults !== undefined
            ? { webSearchResults: body.webSearchResults }
            : {})
        },
        ...(body.output
          ? [
              {
                type: 'tool-result' as const,
                output: boundedText(body.output),
                isError: body.state === 'failed'
              }
            ]
          : [])
      ]
    }
  }
  if (body.kind === 'diff') {
    return {
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Diff', input: { path: body.path } },
        { type: 'tool-result', output: boundedText(body.patch) }
      ]
    }
  }
  if (body.kind === 'approval') {
    if (body.resolution.state === 'pending') {
      return null
    }
    return {
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: `${body.title}\n${body.detail ?? ''}\n${body.resolution.state}`.trim()
        }
      ]
    }
  }
  if (body.kind === 'question') {
    if (body.resolution.state === 'pending') {
      return null
    }
    const choices = body.options.map((option) => option.label).join(' · ')
    return {
      role: 'system',
      blocks: [{ type: 'text', text: `${body.question}\n${choices}`.trim() }]
    }
  }
  // A turn record is timing, not content; a kind this build does not know is
  // never painted as text either, so a newer host can add kinds freely.
  if (body.kind !== 'status' || body.turnLifecycle) {
    return null
  }
  return {
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: body.text,
        ...(body.presentation !== undefined ? { presentation: body.presentation } : {}),
        ...(body.tone !== undefined ? { tone: body.tone } : {}),
        ...(body.providerFrame ? { providerFrame: body.providerFrame } : {})
      }
    ]
  }
}

const projectedItems = new WeakMap<AgentJournalRenderItem, NativeChatMessage | null>()

export function projectStructuredItemsToNativeChat(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  return items.flatMap((item) => {
    const projected = projectStructuredItemToNativeChat(item)
    return projected ? [projected] : []
  })
}

export function projectStructuredItemToNativeChat(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  const cached = projectedItems.get(item)
  if (cached !== undefined) {
    return cached
  }
  // Reducer updates replace journal items, so unchanged rows keep their render caches.
  const projected = itemBlocks(item)
  const message: NativeChatMessage | null = projected
    ? {
        id: item.itemId,
        role: projected.role,
        blocks: projected.blocks,
        timestamp: item.observedAt,
        source: 'transcript'
      }
    : null
  projectedItems.set(item, message)
  return message
}

export function activeStructuredAgentSessionTurnId(
  items: readonly AgentJournalRenderItem[]
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turn = readAgentJournalTurn(items[index]?.body)
    if (turn) {
      return turn.state === 'running' ? turn.turnId : null
    }
  }
  return null
}

export function hasPersistedStructuredAgentSessionTurn(
  items: readonly AgentJournalRenderItem[]
): boolean {
  return items.some(
    (item) =>
      item.body.kind === 'message' && (item.body.role === 'user' || item.body.role === 'assistant')
  )
}

/**
 * A send the host has journaled that the provider has neither opened a turn for nor refused.
 *
 * Codex declares `turn/started` within ~150ms, but Claude's running row can only be written once
 * the SDK echoes the user message back — a 3.4s median and 18s at p90 on real journals. Waiting
 * on that echo to call a session working leaves the whole gap reading idle in the chat and in
 * every session list, so the send itself is the evidence.
 *
 * A live `unknown` still counts because an ambiguous adapter reply does not prove the provider
 * stopped. A recovered `unknown` does not — it outlived the host generation that sent it, so
 * there is nothing still running to report.
 */
export function hasUnansweredStructuredAgentSessionDispatch(
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return submissions.some(
    (submission) =>
      (currentFence == null || submission.fence >= currentFence) &&
      (submission.dispatchState === 'pending' ||
        (submission.dispatchState === 'unknown' &&
          submission.recovered !== true &&
          // Older hosts publish the recovery reason but omit the optional marker.
          submission.reason !== 'host_restarted_before_acknowledgement'))
  )
}

export type StructuredAgentSessionProjectedStatus = 'working' | 'attention' | 'idle'

export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

export function projectStructuredAgentSessionStatus(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): StructuredAgentSessionProjectedStatus {
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
  ) {
    return 'attention'
  }
  return activeStructuredAgentSessionTurnId(items) ||
    hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence)
    ? 'working'
    : 'idle'
}

function messageProse(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The newest user prompt, as the sidebar quotes it. */
export function latestStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return messageProse(body.blocks)
    }
  }
  return ''
}

/** The newest assistant prose in the latest user turn. Tool-only assistant items
 *  are skipped; the user boundary clears prose from the preceding turn. */
export function latestStructuredAgentSessionAssistantMessage(
  items: readonly AgentJournalRenderItem[]
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return ''
    }
    if (body?.kind === 'message' && body.role === 'assistant') {
      const prose = messageProse(body.blocks)
      if (prose.trim()) {
        return prose
      }
    }
  }
  return ''
}

/** The tool call the newest turn is still inside, or null when nothing is running.
 *  Scanning stops at the turn's own lifecycle row so an abandoned `running` call
 *  from an earlier crashed turn can never be reported as live work. */
export function activeStructuredAgentSessionToolCall(
  items: readonly AgentJournalRenderItem[]
): AgentJournalToolCallItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    if (readAgentJournalTurn(body)) {
      return null
    }
    if (body?.kind === 'tool-call' && body.state === 'running') {
      return body
    }
  }
  return null
}

/** The activity fields a sidebar row shows beside the prompt, named as the agent-status
 *  entry names them so the client can hand them straight to a row. */
export type StructuredAgentSessionStatusProjection = {
  status: StructuredAgentSessionProjectedStatus | null
  latestPrompt: string
  /** Present only while a turn is running — see showsAgentToolPreview, which reads
   *  these on any state that carries them. */
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
}

/** One projection shared by host and client: null status means "no turn yet", not idle.
 *  Every text field is bounded to the same preview an agent-status row carries — a send
 *  admits 256 KB, and one status frame carries every retained session at once. The
 *  assistant line is bounded harder than the hook field it stands in for (a preview, not
 *  the 8 KB body): a streamed reply re-projects on every journal checkpoint, so the frame
 *  has to stay small even though the row only ever renders one line of it. */
export function projectStructuredAgentSessionStatusSummary(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): StructuredAgentSessionStatusProjection {
  // A first send has no journalled message until the provider replays it, so the pending
  // dispatch is also what makes a brand-new session listable at all.
  if (
    !hasPersistedStructuredAgentSessionTurn(items) &&
    !hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence)
  ) {
    return { status: null, latestPrompt: '' }
  }
  const status = projectStructuredAgentSessionStatus(items, submissions, currentFence)
  const activeToolCall = status === 'working' ? activeStructuredAgentSessionToolCall(items) : null
  const toolName = activeToolCall
    ? normalizeOptionalField(activeToolCall.name, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    : undefined
  const toolInput = activeToolCall
    ? normalizeOptionalField(
        describeToolInput(activeToolCall.input),
        AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
      )
    : undefined
  const lastAssistantMessage = normalizeOptionalField(
    latestStructuredAgentSessionAssistantMessage(items),
    AGENT_STATUS_MAX_FIELD_LENGTH
  )
  return {
    status,
    latestPrompt: normalizePromptField(latestStructuredAgentSessionPrompt(items)),
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {})
  }
}

/** The agent-status state one projected session status stands for. Shared across the process
 *  boundary so `worktree ps` and the sidebar cannot disagree about the same session. */
export function structuredAgentSessionStatusState(
  status: StructuredAgentSessionProjectedStatus
): 'working' | 'blocked' | 'done' {
  return status === 'working' ? 'working' : status === 'attention' ? 'blocked' : 'done'
}

export function structuredAgentSessionPaneKey(tabId: string, sessionId: string): string {
  const bytes = sha256(new TextEncoder().encode(sessionId))
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const leaf = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return `${tabId}:${leaf}`
}
