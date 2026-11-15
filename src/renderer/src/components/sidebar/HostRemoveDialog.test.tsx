import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { HostRemoveDialog } from './HostRemoveDialog'

const initialState = useAppStore.getState()
const onOpenChange = vi.fn()

function dialogs(openHost: string | null) {
  return ['one', 'two'].map((id) => (
    <HostRemoveDialog
      key={id}
      open={openHost === id}
      onOpenChange={onOpenChange}
      hostId={`ssh:${id}`}
      label={id}
      target={{ kind: 'ssh', targetId: id }}
    />
  ))
}

function replaceCatalogs(count: number) {
  useAppStore.setState({
    worktreesByRepo: {
      [TEST_REPO.id]: Array.from({ length: count }, (_, index) =>
        makeWorktree({ id: `workspace-${index}`, repoId: TEST_REPO.id })
      )
    },
    detectedWorktreesByRepo: {}
  })
}

beforeEach(() => {
  useAppStore.setState({
    repos: [{ ...TEST_REPO, connectionId: 'one' }],
    openFiles: [],
    editorDrafts: {}
  })
  replaceCatalogs(1)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('releases both obsolete catalogs and cached indexes while host dialogs stay mounted', async () => {
  const view = render(dialogs(null))

  function openAndCloseHost(id: string) {
    view.rerender(dialogs(id))
    expect(screen.getByRole('dialog')).toHaveTextContent(`Remove ${id}?`)
    const state = useAppStore.getState()
    const retired = {
      worktrees: new WeakRef(state.worktreesByRepo),
      detected: new WeakRef(state.detectedWorktreesByRepo),
      index: new WeakRef(getIndexedWorktreeMap(selectWorktreesByRepo(state)))
    }
    view.rerender(dialogs(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => replaceCatalogs(2))
    return retired
  }

  const retiredCatalogs = ['one', 'two'].map(openAndCloseHost)
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  for (const retired of retiredCatalogs) {
    expect(retired.worktrees.deref()).toBeUndefined()
    expect(retired.detected.deref()).toBeUndefined()
    expect(retired.index.deref()).toBeUndefined()
  }

  view.rerender(dialogs('one'))
  expect(screen.getByRole('dialog')).toHaveTextContent('Its 3 workspaces stay in Orca')
})
