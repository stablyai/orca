/** @vitest-environment happy-dom */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { useFileExplorerDisplayRootState } from './use-file-explorer-display-root-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
const WORKTREE_ID = 'wt-react185'
const WORKTREE_PATH = '/repo/wt-react185'

let root: Root | undefined
let container: HTMLDivElement | undefined
let renderCount = 0

function TestHarness(): null {
  renderCount += 1
  useFileExplorerDisplayRootState(WORKTREE_ID, { path: WORKTREE_PATH })
  return null
}

describe('useFileExplorerDisplayRootState store selector stability (React #185)', () => {
  beforeEach(() => {
    renderCount = 0
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      worktreesByRepo: {
        'repo-1': [
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mocks minimal worktree record for selector stability test.
          { id: WORKTREE_ID, repoId: 'repo-1', path: WORKTREE_PATH, hostId: 'local' } as Worktree
        ]
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = undefined
    container?.remove()
    container = undefined
    useAppStore.setState(initialAppState, true)
  })

  it('does not re-render on unrelated store state updates', () => {
    act(() => {
      root?.render(<TestHarness />)
    })
    expect(renderCount).toBe(1)

    // Unrelated store update: selector must return the same boolean and avoid re-renders.
    act(() => {
      useAppStore.setState({ activeFileId: '/repo/wt-react185/file.ts' })
    })
    expect(renderCount).toBe(1)
  })

  it('stabilizes without tripping the nested-update limit when an effect synchronizes on hook changes', () => {
    let commitCount = 0
    function CascadeHarness(): null {
      const state = useFileExplorerDisplayRootState(WORKTREE_ID, { path: WORKTREE_PATH })
      useEffect(() => {
        commitCount += 1
        useAppStore.setState({ activeFileId: `/file-${commitCount}.ts` })
      }, [state.displayRootPath, state.outsideWorkspace, state.rootChoice])
      return null
    }

    act(() => {
      root?.render(<CascadeHarness />)
    })

    // Why: selector returns stable primitive values, so the effect only fires on actual changes.
    expect(commitCount).toBe(1)
  })
})
