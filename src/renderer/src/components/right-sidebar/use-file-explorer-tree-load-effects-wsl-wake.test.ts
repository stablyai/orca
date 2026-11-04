// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (state: { settings: null }) => T): T => selector({ settings: null })
}))
vi.mock('./fileExplorerUndoRedo', () => ({ clearFileExplorerUndoHistory: vi.fn() }))

import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const SRC = `${ROOT}\\src`
const DOCS = `${ROOT}\\docs`

const loadDir = vi.fn(
  async (_path: string, _depth: number, _options?: { force?: boolean; wakeWslDistro?: boolean }) =>
    true
)
const resetAndLoad = vi.fn()

function render(expanded: Set<string>) {
  return renderHook(
    ({ dirs }: { dirs: Set<string> }) =>
      useFileExplorerTreeLoadEffects({
        workspaceKey: 'repo-1::wsl',
        visibleFilesWorktreePath: ROOT,
        expanded: dirs,
        dirCache: {},
        loadingDirPaths: new Set(),
        rootError: null,
        isDirStale: () => false,
        loadDir,
        refreshTree: async () => undefined,
        resetAndLoad,
        resetSelection: vi.fn(),
        setNameFilterQuery: vi.fn()
      }),
    { initialProps: { dirs: expanded } }
  )
}

const wokeFor = (dirPath: string): boolean =>
  loadDir.mock.calls.some(
    ([path, , options]) => path === dirPath && options?.wakeWslDistro === true
  )

beforeEach(() => {
  loadDir.mockClear()
  resetAndLoad.mockClear()
})

describe('file explorer folder loads wake a stopped WSL distro only for a folder the user expands (E9)', () => {
  it('a mount re-reading folders that were already open wakes nothing', () => {
    render(new Set([SRC]))
    expect(loadDir).toHaveBeenCalledWith(SRC, 0, {})
    expect(wokeFor(SRC)).toBe(false)
  })

  it('a folder expanded after the mount wakes; the ones already open do not', () => {
    const view = render(new Set([SRC]))
    loadDir.mockClear()
    view.rerender({ dirs: new Set([SRC, DOCS]) })
    expect(wokeFor(DOCS)).toBe(true)
    expect(wokeFor(SRC)).toBe(false)
  })

  it('a remount after host loss, with the same folders open, wakes nothing', () => {
    const first = render(new Set([SRC]))
    first.rerender({ dirs: new Set([SRC, DOCS]) })
    first.unmount()
    loadDir.mockClear()
    render(new Set([SRC, DOCS]))
    expect(wokeFor(SRC)).toBe(false)
    expect(wokeFor(DOCS)).toBe(false)
  })
})
