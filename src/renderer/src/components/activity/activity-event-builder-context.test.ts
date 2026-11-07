import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { getActivityThreadTaskTitle } from '@/lib/activity-thread-display'
import { buildActivityTabContext } from './activity-event-builder-context'

const chatTab = {
  id: 'chat-tab',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Claude Chat',
  generatedLabel: 'Generated chat name',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'claude'
} satisfies Tab

function chatTaskTitle(generatedTitlesEnabled: boolean): string {
  const context = buildActivityTabContext({}, { 'wt-1': [chatTab] }, new Map()).get(chatTab.id)
  if (!context) {
    throw new Error('Missing chat tab context')
  }
  return getActivityThreadTaskTitle({
    entry: { prompt: 'Implement the requested change', stateHistory: [], agentType: 'claude' },
    tab: context.tab,
    generatedTitlesEnabled
  })
}

describe('buildActivityTabContext for native chats', () => {
  it('keeps a generated chat label behind the generated-titles setting', () => {
    expect(chatTaskTitle(false)).toBe('Implement the requested change')
    expect(chatTaskTitle(true)).toBe('Generated chat name')
  })
})
