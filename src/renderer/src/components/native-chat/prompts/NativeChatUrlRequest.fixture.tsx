import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { chatApprovalFromJournal } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'

const url = 'https://linear.app/oauth/authorize?client_id=orca-mcp&response_type=code&state=4f2a9c'

const request: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Sign-in requested',
  description: 'Authorize access to the Linear MCP server.',
  subject: { kind: 'url', url },
  personOnly: true,
  detail: null,
  options: [
    { id: 'open', label: 'Open sign-in page' },
    { id: 'decline', label: 'Decline' }
  ],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}

const opened: AgentJournalApprovalItem = {
  ...request,
  resolution: {
    state: 'resolved',
    selectedOptionId: 'open',
    resolvedBy: 'desktop-renderer',
    resolvedAt: 1_700_000_000_000
  }
}

export const open = defineFixture({
  width: 720,
  render: () => (
    <NativeChatApprovalCard approval={chatApprovalFromJournal(request)} onChoose={() => {}} />
  )
})

export const narrowOpen = defineFixture({ ...open, width: 360 })

export const waiting = defineFixture({
  width: 720,
  render: () => <NativeChatResolutionReceipt body={opened} />
})

export const finished = defineFixture({
  width: 720,
  render: () => (
    <NativeChatResolutionReceipt
      body={{ ...opened, subject: { kind: 'url', url, completedAt: 1_700_000_060_000 } }}
    />
  )
})

export const declined = defineFixture({
  width: 720,
  render: () => (
    <NativeChatResolutionReceipt
      body={{ ...opened, resolution: { ...opened.resolution, selectedOptionId: 'decline' } }}
    />
  )
})
