// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { useAiVaultPanelHostScope } from './ai-vault-host-scope'

const WORKTREE_ID = 'repo-1::/remote/repo'
const resumeTargetState = {
  folderWorkspaces: [],
  projectGroups: [],
  repos: [{ ...TEST_REPO, id: 'repo-1' }],
  worktreesByRepo: {
    'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', hostId: 'runtime:server-1' })]
  }
}

let root: Root | null = null
let scope: string | null = null

function HookProbe(): null {
  scope = useAiVaultPanelHostScope(null, resumeTargetState).executionHostScope
  return null
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  scope = null
})

it('opens on the last workspace host after that workspace closed its last tab', async () => {
  useAppStore.setState({
    activeWorktreeId: null,
    worktreesByRepo: resumeTargetState.worktreesByRepo,
    worktreeNavHistory: [WORKTREE_ID, 'tasks'],
    worktreeNavHistoryIndex: 1
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe))
  })
  expect(scope).toBe('runtime:server-1')
})
