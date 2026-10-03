import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildMobileSessionAgentStatusByWorktree } from './mobile-session-inputs'

const leafA = '11111111-1111-4111-8111-111111111111'
const leafB = '22222222-2222-4222-8222-222222222222'
const plainPane = makePaneKey('tab-1', leafA)
const ownedPane = makePaneKey('tab-1', leafB)

const agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {
  [plainPane]: {
    state: 'working',
    prompt: 'plain',
    paneKey: plainPane,
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  },
  [ownedPane]: {
    state: 'done',
    prompt: 'owned',
    paneKey: ownedPane,
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentPresence: {
      agent: 'claude',
      process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
    }
  }
}
const tabsByWorktree: AppState['tabsByWorktree'] = {
  wt: [
    {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt',
      title: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  ]
}

describe('mobile session agent status publication', () => {
  it('strips host presence while keeping each published status stable across builds', () => {
    const first = buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    const second = buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    expect(first.get('wt')?.get(plainPane)).toBe(agentStatusByPaneKey[plainPane])
    expect(first.get('wt')?.get(ownedPane)).not.toHaveProperty('agentPresence')
    expect(second.get('wt')?.get(ownedPane)).toBe(first.get('wt')?.get(ownedPane))
  })
})
