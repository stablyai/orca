// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMovePendingRendererRewrite } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import { WSL_MOVE_RENDERER_REWRITE_STORE_IDS } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type * as RunnerModule from './wsl-move-renderer-store-rewrites'

const client = vi.hoisted(() => ({
  list: vi.fn<() => Promise<WslMovePendingRendererRewrite[]>>(),
  record: vi.fn()
}))
vi.mock('./wsl-move-renderer-rewrite-client', () => ({
  listPendingWslMoveRendererRewrites: client.list,
  recordWslMoveRendererStoreRewritten: client.record
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'
const LOCAL_ID = `repo-1::${UNC_ROOT}`
const HOST_ID = 'repo-1::/home/u/proj'
const QUICK_OPEN = 'orca.quick-open-history.v1'
const PDF = 'orca.pdf.scale-preferences.v1'
const CSV = 'orca.csv.column-widths.v1'
const NOTEBOOKS = 'orca.notebookPythonEnvironments'
const APPLIED = 'orca.wsl-move.renderer-rewrites.v1'

const localRoute = { executionHostId: 'local', runtimeEnvironmentId: null }
const hostRoute = { executionHostId: 'runtime:wsl-env', runtimeEnvironmentId: 'wsl-env' }
const localQuickOpen = JSON.stringify([localRoute, LOCAL_ID, '//wsl/ubuntu/home/u/proj'])
const hostQuickOpen = JSON.stringify([hostRoute, HOST_ID, '/home/u/proj'])
const sshQuickOpen = JSON.stringify([
  { executionHostId: 'ssh:box', runtimeEnvironmentId: null },
  'repo-9::/srv/x',
  '/srv/x'
])
const localPdf = JSON.stringify([LOCAL_ID, 'local', null, `${UNC_ROOT}\\a.pdf`])
const hostPdf = JSON.stringify([HOST_ID, 'wsl-env', null, '/home/u/proj/a.pdf'])
const localCsv = JSON.stringify([
  JSON.stringify([LOCAL_ID, 'local', null, `${UNC_ROOT}\\a.csv`]),
  ','
])
const hostCsv = JSON.stringify([
  JSON.stringify([HOST_ID, 'wsl-env', null, '/home/u/proj/a.csv']),
  ','
])

function move(
  overrides: Partial<WslMovePendingRendererRewrite> = {}
): WslMovePendingRendererRewrite {
  return {
    migrationId: 'move-1',
    storeIds: [...WSL_MOVE_RENDERER_REWRITE_STORE_IDS],
    destinationEnvironmentId: 'wsl-env',
    destinationHostId: 'runtime:wsl-env',
    distro: 'Ubuntu',
    scopeRepoIds: ['repo-1'],
    scopeFolderWorkspaceIds: [],
    scopeRootPaths: ['/home/u/proj'],
    ...overrides
  }
}

function seedStorage(): void {
  localStorage.setItem(
    QUICK_OPEN,
    JSON.stringify([
      [sshQuickOpen, ['x.ts']],
      [localQuickOpen, ['src/a.ts']]
    ])
  )
  localStorage.setItem(PDF, JSON.stringify({ [localPdf]: { scale: 1.5 } }))
  localStorage.setItem(CSV, JSON.stringify({ [localCsv]: { 0: 120 } }))
  localStorage.setItem(
    NOTEBOOKS,
    JSON.stringify({
      [`${UNC_ROOT}\\nb.ipynb`]: { path: `${UNC_ROOT}\\.venv\\bin\\python`, name: '.venv' }
    })
  )
}

const read = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null')

// A fresh module graph is a renderer reload: in-memory caches start over from storage.
async function loadRunner(): Promise<typeof RunnerModule> {
  vi.resetModules()
  return import('./wsl-move-renderer-store-rewrites')
}

beforeEach(() => {
  localStorage.clear()
  client.list.mockReset()
  client.record.mockReset()
  client.record.mockResolvedValue({ recorded: true })
})
afterEach(() => {
  vi.doUnmock('../components/editor/ipynb-kernel-store')
})

describe('WSL move renderer store rewrites', () => {
  it('adds a host copy beside each moved entry, then records every store', async () => {
    seedStorage()
    client.list.mockResolvedValue([move()])
    await (await loadRunner()).runWslMoveRendererStoreRewrites()

    expect(read(QUICK_OPEN)).toEqual([
      [sshQuickOpen, ['x.ts']],
      [localQuickOpen, ['src/a.ts']],
      [hostQuickOpen, ['src/a.ts']]
    ])
    expect(read(PDF)).toEqual({ [localPdf]: { scale: 1.5 }, [hostPdf]: { scale: 1.5 } })
    expect(read(CSV)).toEqual({ [localCsv]: { 0: 120 }, [hostCsv]: { 0: 120 } })
    expect(read(NOTEBOOKS)).toMatchObject({
      '/home/u/proj/nb.ipynb': { path: '/home/u/proj/.venv/bin/python', name: '.venv' }
    })
    expect(client.record.mock.calls).toEqual(
      WSL_MOVE_RENDERER_REWRITE_STORE_IDS.map((id) => ['move-1', id])
    )
  })

  it('does not re-apply a landed store after a reload, but still records it if pending', async () => {
    seedStorage()
    client.list.mockResolvedValue([move()])
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    // The user drops the host copy afterwards; a reload must not bring it back.
    const pdf = { [localPdf]: { scale: 1.5 } }
    localStorage.setItem(PDF, JSON.stringify(pdf))
    client.record.mockClear()

    await (await loadRunner()).runWslMoveRendererStoreRewrites()

    expect(read(PDF)).toEqual(pdf)
    expect(client.record).toHaveBeenCalledTimes(WSL_MOVE_RENDERER_REWRITE_STORE_IDS.length)
  })

  it('makes room in a full store by dropping the moved source, never another project', async () => {
    const others = Array.from({ length: 63 }, (_, index) => [`other-${index}`, ['x.ts']])
    localStorage.setItem(QUICK_OPEN, JSON.stringify([[localQuickOpen, ['src/a.ts']], ...others]))
    client.list.mockResolvedValue([move()])
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    expect(read(QUICK_OPEN)).toEqual([[hostQuickOpen, ['src/a.ts']], ...others])
  })

  it('neither marks nor records a store whose write storage refused', async () => {
    seedStorage()
    client.list.mockResolvedValue([move()])
    const setItem = localStorage.setItem.bind(localStorage)
    const refuse = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === QUICK_OPEN) {
        throw new Error('quota')
      }
      setItem(key, value)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    refuse.mockRestore()
    warn.mockRestore()
    expect(client.record).not.toHaveBeenCalledWith('move-1', 'quick-open-history')
    expect(read(APPLIED)).not.toContain('move-1:quick-open-history')
  })
})
