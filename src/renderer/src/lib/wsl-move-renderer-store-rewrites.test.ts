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
  it('changes nothing without a committed move', async () => {
    seedStorage()
    const before = { ...localStorage }
    client.list.mockResolvedValue([])
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    expect({ ...localStorage }).toEqual(before)
    expect(localStorage.getItem(APPLIED)).toBeNull()
    expect(client.record).not.toHaveBeenCalled()
  })

  it('never throws when the move list is unavailable, and asks again later', async () => {
    vi.useFakeTimers()
    try {
      client.list.mockRejectedValueOnce(new Error('main not ready')).mockResolvedValue([])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect((await loadRunner()).runWslMoveRendererStoreRewrites()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(client.list).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(client.list).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a record another window was refused', async () => {
    vi.useFakeTimers()
    try {
      client.list.mockResolvedValue([move({ storeIds: ['quick-open-history'] })])
      client.record.mockResolvedValue({ recorded: false, reason: 'not-main-window' })
      await (await loadRunner()).runWslMoveRendererStoreRewrites()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(client.record).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it('retries a store main refused to record instead of leaving the move stuck', async () => {
    // On a real host the marker landed but the ledger entry never did, so every later move was refused.
    vi.useFakeTimers()
    try {
      seedStorage()
      client.list.mockResolvedValue([move({ storeIds: ['quick-open-history'] })])
      client.record.mockResolvedValueOnce({ recorded: false, reason: 'gated-off' })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await (await loadRunner()).runWslMoveRendererStoreRewrites()
      expect(client.record).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(client.record).toHaveBeenCalledTimes(2)
      expect(client.record).toHaveBeenLastCalledWith('move-1', 'quick-open-history')
      // Recorded now: no further retry.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(client.record).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
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

  it('re-applies idempotently when the applied record was lost with a lazy flush', async () => {
    seedStorage()
    client.list.mockResolvedValue([move({ storeIds: [] })])
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    const once = { ...localStorage }
    localStorage.removeItem(APPLIED)

    await (await loadRunner()).runWslMoveRendererStoreRewrites()

    expect({ ...localStorage }).toEqual(once)
    // A move past its rewrite phase is re-applied, never recorded.
    expect(client.record).not.toHaveBeenCalled()
  })

  it('leaves entries of projects the move did not take', async () => {
    seedStorage()
    client.list.mockResolvedValue([move({ scopeRepoIds: ['repo-2'], scopeRootPaths: ['/srv'] })])
    const before = { ...localStorage }
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    for (const key of [QUICK_OPEN, PDF, CSV, NOTEBOOKS]) {
      expect(localStorage.getItem(key)).toBe(before[key])
    }
  })

  it('joins a second call instead of running the stores twice at once', async () => {
    seedStorage()
    client.list.mockResolvedValue([move()])
    const runner = await loadRunner()
    await Promise.all([
      runner.runWslMoveRendererStoreRewrites(),
      runner.runWslMoveRendererStoreRewrites()
    ])
    expect(client.list).toHaveBeenCalledOnce()
    expect(read(QUICK_OPEN)).toHaveLength(3)
  })

  it('records neither marker nor ledger entry for a store that fails, and goes on', async () => {
    seedStorage()
    client.list.mockResolvedValue([move()])
    vi.doMock('../components/editor/ipynb-kernel-store', () => ({
      copyEnvironments: () => {
        throw new Error('storage broke')
      }
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (await loadRunner()).runWslMoveRendererStoreRewrites()
    warn.mockRestore()

    expect(client.record.mock.calls).toEqual([
      ['move-1', 'quick-open-history'],
      ['move-1', 'file-view-preferences']
    ])
    expect(read(APPLIED)).toEqual(['move-1:quick-open-history', 'move-1:file-view-preferences'])
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
