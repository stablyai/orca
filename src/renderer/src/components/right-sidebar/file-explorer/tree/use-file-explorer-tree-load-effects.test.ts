// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

const initial = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function setFollowSymlinks(value: boolean): void {
  const settings = useAppStore.getState().settings ?? getDefaultSettings('/home/test')
  useAppStore.setState({ settings: { ...settings, followSymlinkedDirectories: value } })
}

const INITIAL_TREE: { visible: string | null } = { visible: '/repo/a' }

/** Counts root reloads while search hides the tree (visible path null) and reveals it again. */
function renderTree() {
  const resetAndLoad = vi.fn()
  const hook = renderHook(
    ({ visible }: { visible: string | null }) =>
      useFileExplorerTreeLoadEffects({
        workspaceKey: null,
        visibleFilesWorktreePath: visible,
        expanded: new Set(),
        dirCache: {},
        loadingDirPaths: new Set(),
        rootError: null,
        isDirStale: () => false,
        loadDir: async () => true,
        refreshTree: async () => undefined,
        resetAndLoad,
        resetSelection: () => {},
        clearNameFilter: () => {}
      }),
    { initialProps: INITIAL_TREE }
  )
  return { ...hook, resetAndLoad }
}

describe('file tree reload around a hidden symlink setting change', () => {
  it('reloads once when the same tree comes back after the setting changed under search', () => {
    setFollowSymlinks(false)
    const { rerender, resetAndLoad } = renderTree()
    expect(resetAndLoad).toHaveBeenCalledTimes(1)

    rerender({ visible: null })
    act(() => setFollowSymlinks(true))
    expect(resetAndLoad).toHaveBeenCalledTimes(1)

    rerender({ visible: '/repo/a' })
    expect(resetAndLoad).toHaveBeenCalledTimes(2)
  })

  it('reloads only once when a different path comes back after the setting changed', () => {
    setFollowSymlinks(false)
    const { rerender, resetAndLoad } = renderTree()
    rerender({ visible: null })
    act(() => setFollowSymlinks(true))

    rerender({ visible: '/repo/b' })
    // The new path's own reset already lists with the new setting.
    expect(resetAndLoad).toHaveBeenCalledTimes(2)
  })
})
