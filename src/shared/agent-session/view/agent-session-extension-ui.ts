// Extension UI (pi's notify/setStatus/setWidget) travels as journal status rows because that is
// the only additive channel every host and client already carries. The transient ones are drawn
// beside the composer, so they stay out of the transcript.

import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import type { NativeChatTextBlock } from '../../native-chat/native-chat-types'

/** A notice the extension itself typed: an ordinary notice line, never an agent failure. */
export const AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION = 'extension-notice'
/** One entry of the extension's keyed status line. */
export const AGENT_SESSION_EXTENSION_STATUS_PRESENTATION = 'extension-status'
/** Plain text lines the extension pins above the composer. */
export const AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION = 'extension-widget'
/** The same, pinned below it. */
export const AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION = 'extension-widget-below'

const STRIP_PRESENTATIONS: ReadonlySet<string> = new Set([
  AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION
])

/** Status and widget rows live in the composer's strips; drawing them in the transcript would duplicate them. */
export function isAgentSessionExtensionStripPresentation(
  presentation: string | undefined
): boolean {
  return presentation !== undefined && STRIP_PRESENTATIONS.has(presentation)
}

export function isAgentSessionExtensionStripBlock(block: NativeChatTextBlock): boolean {
  return isAgentSessionExtensionStripPresentation(block.presentation)
}

export type AgentSessionExtensionStatusRow = { itemId: string; text: string }

export type AgentSessionExtensionWidgetRow = {
  itemId: string
  placement: 'above' | 'below'
  lines: readonly string[]
}

export type AgentSessionExtensionStripRows = {
  statuses: readonly AgentSessionExtensionStatusRow[]
  widgets: readonly AgentSessionExtensionWidgetRow[]
}

const NO_STRIP_ROWS: AgentSessionExtensionStripRows = { statuses: [], widgets: [] }

/** A key the extension cleared is written as an empty row; it stops drawing there. */
function liveLines(text: string): string[] {
  const lines = text.split('\n')
  return lines.some((line) => line.trim().length > 0) ? lines : []
}

/** The strips beside the composer, in journal order, from the rows a host wrote for an extension. */
export function agentSessionExtensionStripRows(
  items: readonly AgentJournalRenderItem[]
): AgentSessionExtensionStripRows {
  let rows: {
    statuses: AgentSessionExtensionStatusRow[]
    widgets: AgentSessionExtensionWidgetRow[]
  } | null = null
  for (const item of items) {
    const { body } = item
    if (body.kind !== 'status' || !isAgentSessionExtensionStripPresentation(body.presentation)) {
      continue
    }
    const lines = liveLines(body.text)
    if (lines.length === 0) {
      continue
    }
    rows ??= { statuses: [], widgets: [] }
    if (body.presentation === AGENT_SESSION_EXTENSION_STATUS_PRESENTATION) {
      rows.statuses.push({ itemId: item.itemId, text: body.text })
      continue
    }
    rows.widgets.push({
      itemId: item.itemId,
      placement:
        body.presentation === AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION ? 'below' : 'above',
      lines
    })
  }
  return rows ?? NO_STRIP_ROWS
}
