import type { AgentJournalRenderItem } from './agent-session-journal-types'
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
        { type: 'tool-call', name: body.name, input: body.input, state: body.state },
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
  if (body.turnLifecycle) {
    return null
  }
  return {
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: body.text,
        ...(body.providerFrame ? { providerFrame: body.providerFrame } : {})
      }
    ]
  }
}

export function projectStructuredItemsToNativeChat(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  return items.flatMap((item) => {
    const projected = itemBlocks(item)
    return projected
      ? [
          {
            id: item.itemId,
            role: projected.role,
            blocks: projected.blocks,
            timestamp: item.observedAt,
            source: 'transcript'
          }
        ]
      : []
  })
}

export function projectStructuredItemToNativeChat(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  return projectStructuredItemsToNativeChat([item])[0] ?? null
}

export function activeStructuredAgentSessionTurnId(
  items: readonly AgentJournalRenderItem[]
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    if (body?.kind === 'status' && body.turnLifecycle) {
      return body.turnLifecycle.state === 'running' ? body.turnLifecycle.turnId : null
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

export type StructuredAgentSessionProjectedStatus = 'working' | 'attention' | 'idle'

export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

export function projectStructuredAgentSessionStatus(
  items: readonly AgentJournalRenderItem[]
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
  return activeStructuredAgentSessionTurnId(items) ? 'working' : 'idle'
}

export function structuredAgentSessionPaneKey(tabId: string, sessionId: string): string {
  const bytes = sha256(new TextEncoder().encode(sessionId))
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const leaf = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return `${tabId}:${leaf}`
}
