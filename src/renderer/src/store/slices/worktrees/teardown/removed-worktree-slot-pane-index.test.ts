import { expect, it } from 'vitest'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../../../../../../shared/worktree/host-qualified-identity'
import {
  forEachPaneDisplayer,
  recordDisplayedPanes
} from '@/components/sidebar/worktree-card-slot-pane-index'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'
import { buildWorktreePurgeState } from './worktree-purge-state'

function displayers(paneKey: string): string[] {
  const ids: string[] = []
  forEachPaneDisplayer(paneKey, (id) => ids.push(id))
  return ids
}

it('retires displayed pane owners after explicit workspace removal and identity reuse', () => {
  const store = createTestStore()
  const identity = composeWorktreeHostIdentity('local', 'removed-slot')
  recordDisplayedPanes(identity, ['old-pane', 'reused-pane'])
  applyRemoveWorktreeSuccessState(store.setState, 'removed-slot', new Set())
  expect(displayers('old-pane')).toEqual([])
  expect(displayers('reused-pane')).toEqual([])

  recordDisplayedPanes(identity, ['new-pane'])
  expect(displayers('new-pane')).toEqual(['removed-slot'])
  applyRemoveWorktreeSuccessState(store.setState, 'removed-slot', new Set())
  expect(displayers('new-pane')).toEqual([])
})

it('retires historical owners during repeated bulk workspace churn', () => {
  const store = createTestStore()
  for (let index = 0; index < 32; index += 1) {
    const id = `churn-slot-${index}`
    recordDisplayedPanes(composeWorktreeHostIdentity('local', id), ['churn-pane'])
    recordDisplayedPanes(composeWorktreeHostIdentity('runtime:box', id), ['churn-pane'])
    buildWorktreePurgeState(store.getState(), [id])
  }
  expect(displayers('churn-pane')).toEqual([])
})

it('preserves the surviving host twin when retiring a pane owner', () => {
  const store = createTestStore()
  store.setState({
    worktreesByRepo: {
      repo: [
        makeWorktree({ id: 'repo::/slot-twin', repoId: 'repo', hostId: 'local' }),
        makeWorktree({ id: 'repo::/slot-twin', repoId: 'repo', hostId: 'runtime:box' })
      ]
    }
  })
  recordDisplayedPanes(composeWorktreeHostIdentity('local', 'repo::/slot-twin'), [
    'twin-pane',
    'local-twin-pane'
  ])
  recordDisplayedPanes(composeWorktreeHostIdentity('runtime:box', 'repo::/slot-twin'), [
    'twin-pane',
    'remote-twin-pane'
  ])
  buildWorktreePurgeState(store.getState(), [
    hostWorktreeTarget({ id: 'repo::/slot-twin', hostId: 'runtime:box' })
  ])
  expect(displayers('twin-pane')).toEqual(['repo::/slot-twin'])
  expect(displayers('local-twin-pane')).toEqual(['repo::/slot-twin'])
  expect(displayers('remote-twin-pane')).toEqual([])
  buildWorktreePurgeState(store.getState(), ['repo::/slot-twin'])
  expect(displayers('twin-pane')).toEqual([])
})
