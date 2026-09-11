// @vitest-environment happy-dom
//
// Chat tabs carry the host that published them, pinned once. Without the stamp every consumer had
// to re-derive the owner from the worktree, which is what pointed open panes at replacement hosts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { buildMirroredAgentTabs } from './web-session-tabs-sync/terminal-surfaces'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  makeSnapshot,
  resetWebSessionTabsSyncTestState,
  WT,
  NOW
} from './web-session-tabs-sync-test-harness'

const agentTab = {
  type: 'agent-session',
  id: 'host-tab-1',
  sessionId: 'session-1',
  agent: 'codex',
  title: 'Chat',
  isActive: true
} as const

function existingTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'structured-tab-1',
    entityId: 'session-1',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    worktreeId: WT,
    groupId: 'g',
    label: 'Chat',
    customLabel: null,
    color: null,
    createdAt: 1,
    sortOrder: 0,
    ...overrides
  }
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 5 }])
})

afterEach(() => replaceRuntimeEnvironmentRevisions([]))

describe('buildMirroredAgentTabs stamps the publishing host', () => {
  it('records the environment and the revision it published under', () => {
    const tabs = buildMirroredAgentTabs(
      makeSnapshot([agentTab]),
      new Map(),
      'g',
      0,
      [],
      NOW,
      'runtime:env-a'
    )
    expect(tabs[0]!.unifiedTab.executionHostId).toBe('runtime:env-a')
    expect(tabs[0]!.unifiedTab.runtimeOwnerPairingRevision).toBe(5)
  })

  it('stamps local for a mirror with no owner host, carrying no revision', () => {
    const tabs = buildMirroredAgentTabs(makeSnapshot([agentTab]), new Map(), 'g', 0, [], NOW)
    expect(tabs[0]!.unifiedTab.executionHostId).toBe('local')
    expect(tabs[0]!.unifiedTab.runtimeOwnerPairingRevision).toBeUndefined()
  })

  it('pins an existing stamp so a later publication cannot move an open pane', () => {
    const tabs = buildMirroredAgentTabs(
      makeSnapshot([agentTab]),
      new Map(),
      'g',
      0,
      [existingTab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 2 })],
      NOW,
      'runtime:env-a'
    )
    expect(tabs[0]!.unifiedTab.runtimeOwnerPairingRevision).toBe(2)
  })

  it('stamps a tab that predates stamping with the host now publishing it', () => {
    const tabs = buildMirroredAgentTabs(
      makeSnapshot([agentTab]),
      new Map(),
      'g',
      0,
      [existingTab({})],
      NOW,
      'local'
    )
    expect(tabs[0]!.unifiedTab.executionHostId).toBe('local')
  })
})
