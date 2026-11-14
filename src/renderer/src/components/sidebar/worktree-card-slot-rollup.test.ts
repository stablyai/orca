import { expect, it } from 'vitest'
import { slotTargetsOfKind, workspaceUnreadTarget } from './worktree-card-slot-targets'

const pane = (tab: string) => `${tab}:11111111-1111-4111-8111-111111111111`

it('deduplicates an omitted local host against an explicitly local unread agent', () => {
  const agent = {
    ...workspaceUnreadTarget('child', 2, 'local'),
    paneKey: pane('agent')
  }
  const tab = { ...workspaceUnreadTarget('child', 1), tabId: 'agent' }
  expect(slotTargetsOfKind([agent, tab], 'unread').map((target) => target.paneKey)).toEqual([
    'agent:11111111-1111-4111-8111-111111111111'
  ])
  expect(
    slotTargetsOfKind([{ ...tab, unreadPaneKeys: [pane('agent')] }, agent], 'unread').map(
      (target) => target.paneKey
    )
  ).toEqual(['agent:11111111-1111-4111-8111-111111111111'])
})
