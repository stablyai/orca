// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { agentSessionTabsOfRow } from './worktree-context-menu-policy'

function agentTab(overrides: Partial<Tab> & { id: string }): Tab {
  return makeUnifiedTab({
    worktreeId: 'w',
    groupId: 'g',
    contentType: 'agent-session',
    ...overrides
  })
}

describe('agentSessionTabsOfRow', () => {
  it('offers the row host’s agent chats only, keeping unstamped legacy tabs', () => {
    const tabs = [
      agentTab({ id: 'unstamped', entityId: 'session-a' }),
      agentTab({ id: 'twin-host', entityId: 'session-b', executionHostId: 'ssh:twin' }),
      agentTab({ id: 'row-host', entityId: 'session-c', executionHostId: 'ssh:row' }),
      makeUnifiedTab({ id: 'terminal', worktreeId: 'w', groupId: 'g', contentType: 'terminal' }),
      agentTab({ id: 'blank-id', entityId: '   ' })
    ]

    expect(agentSessionTabsOfRow(tabs, 'ssh:row').map((tab) => tab.id)).toEqual([
      'unstamped',
      'row-host'
    ])
    expect(agentSessionTabsOfRow(tabs, 'local').map((tab) => tab.id)).toEqual(['unstamped'])
  })
})
