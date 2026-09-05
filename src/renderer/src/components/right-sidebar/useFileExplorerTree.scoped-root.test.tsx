// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { getExplorerEffectiveExpanded } from './file-explorer-display-root'

const read = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' })
}))
const listing = (name?: string) => ({
  entries: name ? [{ name, isDirectory: false }] : [],
  operationOwner: { kind: 'local' }
})
beforeEach(() => read.mockReset().mockResolvedValue(listing()))
afterEach(cleanup)

it('refreshes a scoped root after Collapse All and clears read errors on recovery', async () => {
  const expanded = getExplorerEffectiveExpanded(new Set(), '/repo/packages/app')
  const { result } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt'))
  read.mockResolvedValueOnce(listing('before.ts'))
  await act(async () => {
    await result.current.loadDir('/repo/packages/app', 1)
  })
  read.mockImplementation(async (_id, _root, path) => {
    if (path === '/repo/packages/app') {
      throw new Error('Host unavailable')
    }
    return listing()
  })
  await act(async () => {
    await result.current.refreshTree()
  })
  expect(result.current.dirCache['/repo/packages/app']).toMatchObject({
    error: 'Host unavailable',
    children: [{ relativePath: 'packages/app/before.ts', depth: 2 }]
  })
  read.mockResolvedValue(listing('after.ts'))
  await act(async () => {
    await result.current.refreshTree()
  })
  expect(result.current.dirCache['/repo/packages/app'].error).toBeUndefined()
  expect(result.current.dirCache['/repo/packages/app'].children[0]).toMatchObject({
    relativePath: 'packages/app/after.ts',
    depth: 2
  })
})

it('distinguishes an unreadable scoped directory from an empty one and allows forced retry', async () => {
  const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt'))
  read.mockRejectedValueOnce(new Error('Permission denied'))
  await act(async () => {
    await result.current.loadDir('/repo/app', 0)
  })
  expect(result.current.rootError).toBeNull()
  expect(result.current.dirCache['/repo/app'].error).toBe('Permission denied')
  await act(async () => {
    await result.current.refreshDir('/repo/app')
  })
  expect(result.current.dirCache['/repo/app']).toMatchObject({ children: [] })
  expect(result.current.dirCache['/repo/app'].error).toBeUndefined()
})
