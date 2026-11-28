// @vitest-environment happy-dom
// Perf contract (Cmd+K first paint): at 1,900 workspaces the opening frame built and mounted every
// result section before the input could paint (~150 ms cold). The opening commit now mounts the input
// with no result rows and builds no workspace search documents; both arrive once that frame has painted.
import { act, cleanup, render } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as WorktreePaletteDocumentModule from '@/lib/workspace/search/worktrees/worktree-palette-document'

const documentsBuilt = vi.hoisted((): { count: number } => ({ count: 0 }))

vi.mock('@/lib/workspace/search/worktrees/worktree-palette-document', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreePaletteDocumentModule>()
  return {
    ...actual,
    buildWorktreePaletteDocuments: (
      ...args: Parameters<typeof actual.buildWorktreePaletteDocuments>
    ) => {
      const documents = actual.buildWorktreePaletteDocuments(...args)
      documentsBuilt.count += documents.size
      return documents
    }
  }
})

import { useAppStore } from '@/store'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

const WORKSPACE_COUNT = 1900
const initialState = useAppStore.getState()

function resultRowCount(): number {
  return document.querySelectorAll('[cmdk-item]').length
}

beforeEach(() => {
  vi.useFakeTimers()
  documentsBuilt.count = 0
  const worktrees = Array.from({ length: WORKSPACE_COUNT }, (_, index) =>
    makeWorktree(`repo-1::/tmp/ws-${index}`, `ws-${index}`, {
      path: `/tmp/ws-${index}`,
      branch: `refs/heads/ws-${index}`,
      lastActivityAt: index
    })
  )
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': worktrees },
    activeModal: 'none'
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

it('mounts no result rows in the opening commit and fills them in after the paint', async () => {
  render(<WorktreeJumpPalette />)

  act(() => {
    useAppStore.setState({ activeModal: 'worktree-palette' })
  })
  expect(document.querySelector('[cmdk-input]')).not.toBeNull()
  expect(resultRowCount()).toBe(0)
  expect(documentsBuilt.count).toBe(0)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  // The empty-query first screen for this fixture.
  expect(resultRowCount()).toBe(11)
  expect(documentsBuilt.count).toBe(WORKSPACE_COUNT)
})

it('reuses cached results when the palette reopens during its close linger', async () => {
  render(<WorktreeJumpPalette />)
  act(() => {
    useAppStore.setState({ activeModal: 'worktree-palette' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  act(() => {
    useAppStore.setState({ activeModal: 'none' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })

  documentsBuilt.count = 0

  act(() => {
    useAppStore.setState({ activeModal: 'worktree-palette' })
  })
  // Still mounted with its index built: rows show at once and no search document is rebuilt.
  expect(resultRowCount()).toBe(11)
  expect(documentsBuilt.count).toBe(0)
})

it('builds results once while unrelated store writes keep arriving', async () => {
  // Real scheduler: act() would apply the reveal without yielding, hiding a discarded, restarted build.
  vi.useRealTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let writes = 0
  const churn = setInterval(() => {
    writes += 1
    useAppStore.setState({ activeBrowserTabId: `churn-${writes}` })
  }, 5)
  try {
    root.render(<WorktreeJumpPalette />)
    useAppStore.setState({ activeModal: 'worktree-palette' })
    // A restarted transition starves under the writes until React's ~5 s expiry.
    await vi.waitFor(() => expect(resultRowCount()).toBe(11), { timeout: 4000, interval: 10 })
    expect(documentsBuilt.count).toBe(WORKSPACE_COUNT)
  } finally {
    clearInterval(churn)
    root.unmount()
    host.remove()
    vi.unstubAllGlobals()
  }
})
