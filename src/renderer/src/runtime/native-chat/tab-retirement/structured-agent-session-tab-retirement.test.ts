// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  markStructuredAgentLaunchCancelledPersisted
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { suppressCancelledStructuredSessionTabs } from './structured-agent-session-tab-retirement'

const { retire } = vi.hoisted(() => ({ retire: vi.fn(async () => true) }))
vi.mock('./structured-agent-session-host-tab-retirement', () => ({
  retireStructuredAgentSessionTab: retire
}))

it('accepts a reopened chat without reviving the canceled launch or touching another host', () => {
  const target = { kind: 'environment', environmentId: 'lab' } as const
  const worktree = 'repo::/synthetic-workspace'
  const reopenedId = 'agent-chat-tab-v1-4ae57680-e17a-492d-a3e3-ce85a8045470'
  markStructuredAgentLaunchCancelledPersisted('reopened', 'runtime:lab')
  markStructuredAgentLaunchCancelledPersisted('late-launch', 'runtime:lab')
  markStructuredAgentLaunchCancelledPersisted('elsewhere', 'runtime:other-host')
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree,
    publicationEpoch: 'test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: reopenedId,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: reopenedId,
        sessionId: 'reopened',
        title: 'Reopened',
        agent: 'antigravity',
        isActive: true
      },
      {
        type: 'agent-session',
        id: 'agent-session:late-launch',
        sessionId: 'late-launch',
        title: 'Late launch',
        agent: 'antigravity',
        isActive: false
      },
      {
        type: 'agent-session',
        id: 'agent-session:elsewhere',
        sessionId: 'elsewhere',
        title: 'Other host',
        agent: 'antigravity',
        isActive: false
      }
    ]
  }

  const visible = suppressCancelledStructuredSessionTabs(snapshot, target)
  expect(visible.activeTabId).toBe('agent-chat-tab-v1-4ae57680-e17a-492d-a3e3-ce85a8045470')
  expect(visible.tabs.map((tab) => tab.id)).toEqual([
    'agent-chat-tab-v1-4ae57680-e17a-492d-a3e3-ce85a8045470',
    'agent-session:elsewhere'
  ])
  expect(retire).toHaveBeenCalledExactlyOnceWith({
    target,
    worktreeId: worktree,
    sessionId: 'late-launch',
    onError: undefined
  })
  expect(hasStructuredAgentLaunchCancellationTombstonePersisted('reopened')).toBe(false)
  expect(hasStructuredAgentLaunchCancellationTombstonePersisted('late-launch')).toBe(true)
  expect(hasStructuredAgentLaunchCancellationTombstonePersisted('elsewhere')).toBe(true)
})
