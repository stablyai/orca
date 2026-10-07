import { expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { StructuredAgentLaunchHooks } from './structured-agent-launch-settlement'

const mocks = vi.hoisted(() => {
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  return {
    store: { unifiedTabsByWorktree },
    begin: vi.fn<(args: { hooks: StructuredAgentLaunchHooks }) => null>(() => null)
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  structuredLaunchPairedOwner: () => ({ executionHostId: 'host-1' }),
  beginStructuredAgentSessionProvisionalLaunch: mocks.begin
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { launchStructuredAgentFromNewTab } from './launch-agent-in-new-tab-structured-route'

it('reports the admitted paired session tab, never a sibling or a missing session', () => {
  const onCreatedTab = vi.fn()
  launchStructuredAgentFromNewTab({
    plan: adoptAgentSessionLaunchVerdict({
      requestId: 'request-1',
      route: 'structured-native-chat',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'continue',
      promptDelivery: 'auto-submit'
    }),
    worktreeId: 'wt-1',
    onCreatedTab,
    openTerminal: () => null
  })
  const hook = mocks.begin.mock.calls[0][0].hooks.onStructuredReady
  const tab: Tab = {
    id: 'exact-tab',
    entityId: 'session-1',
    contentType: 'agent-session',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    label: 'Codex',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  mocks.store.unifiedTabsByWorktree = {
    'wt-1': [tab],
    'wt-other': [{ ...tab, id: 'sibling', worktreeId: 'wt-other' }]
  }
  hook?.('session-1')
  expect(onCreatedTab).toHaveBeenCalledExactlyOnceWith('exact-tab')
  hook?.('session-missing')
  mocks.store.unifiedTabsByWorktree['wt-1'] = []
  hook?.('session-1')
  expect(onCreatedTab).toHaveBeenCalledOnce()
})
