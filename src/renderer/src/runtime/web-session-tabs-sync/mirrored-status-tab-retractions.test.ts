import { beforeEach, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  LEAF_ID,
  makeState,
  NOW,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import type { WebSessionTabsBatchContext } from './state'
import { collectUnhydratedMirroredTabRetractions } from './mirrored-status-tab-retractions'
import { setHostSessionTabIdMapping } from './tracking-mappings'

beforeEach(resetWebSessionTabsSyncTestState)

it('indexes statuses once per batch instead of once per workspace', () => {
  let enumerations = 0
  const state = makeState()
  const batchContext: WebSessionTabsBatchContext = {
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  for (let index = 0; index < 100; index++) {
    const tabId = toWebTerminalSurfaceTabId(`host-${index}`)
    const worktreeId = `folder:${index}`
    const paneKey = makePaneKey(tabId, LEAF_ID)
    state.agentStatusByPaneKey[paneKey] = {
      paneKey,
      tabId,
      worktreeId,
      connectionId: 'host',
      agentType: 'omp',
      state: 'done',
      prompt: 'Finished',
      updatedAt: NOW,
      stateStartedAt: NOW,
      stateHistory: []
    }
    setHostSessionTabIdMapping({ environmentId: 'host', worktreeId, tabId }, `host-${index}`)
  }
  state.agentStatusByPaneKey = new Proxy(state.agentStatusByPaneKey, {
    ownKeys(target) {
      enumerations++
      return Reflect.ownKeys(target)
    }
  })
  for (let index = 0; index < 100; index++) {
    const args = {
      state,
      environmentId: 'host',
      worktreeId: `folder:${index}`,
      nextHostTerminalTabIds: new Set<string>(),
      currentTerminalIds: new Set<string>(),
      batchContext
    }
    expect(collectUnhydratedMirroredTabRetractions(args)).toEqual([
      toWebTerminalSurfaceTabId(`host-${index}`)
    ])
  }
  expect(enumerations).toBe(1)
})

it('does not retract a colliding tab id owned by another host', () => {
  const state = makeState()
  const tabId = toWebTerminalSurfaceTabId('same-tab')
  const paneKey = makePaneKey(tabId, LEAF_ID)
  state.agentStatusByPaneKey[paneKey] = {
    paneKey, tabId, worktreeId: 'folder:1', connectionId: 'host-b', agentType: 'omp', state: 'done', prompt: '', updatedAt: NOW, stateStartedAt: NOW, stateHistory: []
  }
  setHostSessionTabIdMapping({ environmentId: 'host-a', worktreeId: 'folder:1', tabId }, 'same-tab')
  expect(collectUnhydratedMirroredTabRetractions({ state, environmentId: 'host-a', worktreeId: 'folder:1', nextHostTerminalTabIds: new Set(), currentTerminalIds: new Set() })).toEqual([])
})
