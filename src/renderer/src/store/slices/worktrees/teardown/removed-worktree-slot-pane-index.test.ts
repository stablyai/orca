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
import { buildWorktreePurgeState } from './worktree-purge-state'

function displayers(paneKey: string): string[] {
  const ids: string[] = []
  forEachPaneDisplayer(paneKey, (id) => ids.push(id))
  return ids
}

it('preserves the surviving host twin when retiring a pane owner', () => {
  const store = createTestStore()
  store.setState({
    workspaceUnreadRaisedByMarkers: {
      [composeWorktreeHostIdentity('local', 'repo::/slot-twin')]: true,
      [composeWorktreeHostIdentity('runtime:box', 'repo::/slot-twin')]: true
    },
    workspacesMarkedUnreadByUser: {
      [composeWorktreeHostIdentity('local', 'repo::/slot-twin')]: true,
      [composeWorktreeHostIdentity('runtime:box', 'repo::/slot-twin')]: true
    },
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
  store.setState(
    buildWorktreePurgeState(store.getState(), [
      hostWorktreeTarget({ id: 'repo::/slot-twin', hostId: 'runtime:box' })
    ])
  )
  expect(displayers('twin-pane')).toEqual(['repo::/slot-twin'])
  expect(displayers('local-twin-pane')).toEqual(['repo::/slot-twin'])
  expect(displayers('remote-twin-pane')).toEqual([])
  expect(store.getState().workspaceUnreadRaisedByMarkers).toEqual({
    'local|repo::/slot-twin': true
  })
  expect(store.getState().workspacesMarkedUnreadByUser).toEqual({ 'local|repo::/slot-twin': true })
  store.setState(buildWorktreePurgeState(store.getState(), ['repo::/slot-twin']))
  expect(displayers('twin-pane')).toEqual([])
  expect(store.getState().workspaceUnreadRaisedByMarkers).toEqual({})
  expect(store.getState().workspacesMarkedUnreadByUser).toEqual({})
})
