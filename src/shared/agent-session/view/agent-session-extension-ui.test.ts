import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../journal/agent-session-journal-types'
import { nativeChatRowRendersContent } from '../../native-chat/transcript/row-content/native-chat-row-content'
import { structuredAgentSessionStatusBlock } from './structured-agent-session-status-block'
import {
  AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION,
  AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION,
  agentSessionExtensionStripRows
} from './agent-session-extension-ui'

function item(
  itemId: string,
  body: AgentJournalItemBody,
  sequence: number
): AgentJournalRenderItem {
  return { itemId, revision: 1, body, sequence, observedAt: 1, turnScope: { kind: 'thread' } }
}

function strip(
  itemId: string,
  presentation: string,
  text: string,
  sequence: number
): AgentJournalRenderItem {
  return item(itemId, { kind: 'status', text, presentation }, sequence)
}

describe('extension UI strips', () => {
  it('reads keyed statuses and widgets from the rows a host wrote for an extension', () => {
    const rows = agentSessionExtensionStripRows([
      item(
        'notice',
        {
          kind: 'status',
          text: 'Todo list updated',
          presentation: AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION
        },
        1
      ),
      strip('status', AGENT_SESSION_EXTENSION_STATUS_PRESENTATION, 'Turn 3 running…', 2),
      strip('widget', AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION, '[ ] a\n[x] b', 3),
      strip('footer', AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION, '3 warnings', 4),
      item('turn', { kind: 'status', text: 'Compaction skipped' }, 5)
    ])

    expect(rows.statuses).toEqual([{ itemId: 'status', text: 'Turn 3 running…' }])
    expect(rows.widgets).toEqual([
      { itemId: 'widget', placement: 'above', lines: ['[ ] a', '[x] b'] },
      { itemId: 'footer', placement: 'below', lines: ['3 warnings'] }
    ])
  })

  it('stops drawing a key the extension cleared', () => {
    expect(
      agentSessionExtensionStripRows([
        strip('widget', AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION, '', 1),
        strip('status', AGENT_SESSION_EXTENSION_STATUS_PRESENTATION, '\n ', 2)
      ])
    ).toEqual({ statuses: [], widgets: [] })
  })

  it('keeps strip rows out of the transcript while the extension’s notice still draws there', () => {
    expect(
      nativeChatRowRendersContent([
        structuredAgentSessionStatusBlock({
          kind: 'status',
          text: '[ ] a',
          presentation: AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION
        })
      ])
    ).toBe(false)
    expect(
      nativeChatRowRendersContent([
        structuredAgentSessionStatusBlock({
          kind: 'status',
          text: 'Todo list updated',
          presentation: AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION
        })
      ])
    ).toBe(true)
  })
})
