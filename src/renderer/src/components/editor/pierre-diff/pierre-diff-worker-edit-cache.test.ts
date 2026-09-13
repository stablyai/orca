import { DiffHunksRenderer, type FileDiffMetadata, type ThemedDiffResult } from '@pierre/diffs'
import type { WorkerPoolManager } from '@pierre/diffs/worker'
import { expect, it, vi } from 'vitest'

it('starts editing from a worker result and gives the editor its own mutable line array', () => {
  const options = { theme: 'dark-plus', useTokenTransformer: true }
  const external = {
    name: 'file.ts',
    cacheKey: 'external',
    additionLines: ['new\n']
  } as FileDiffMetadata
  const session = { ...external, cacheKey: 'session' }
  const result = {
    code: { additionLines: [{ type: 'element' }], deletionLines: [] }
  } as unknown as ThemedDiffResult
  const worker = {
    isWorkingPool: () => true,
    getDiffRenderOptions: () => options,
    getDiffResultCache: vi.fn(() => ({ options, result }))
  } as unknown as WorkerPoolManager
  const renderer = new DiffHunksRenderer({}, undefined, undefined, worker)
  renderer.beginEditSession(session, external)
  expect(renderer.editorRenderReady()).toBe(true)
  expect(renderer.diffCache).toBe(session)
  const cache = (renderer as unknown as { renderCache: { result: ThemedDiffResult } }).renderCache
  expect(cache.result.code.additionLines).not.toBe(result.code.additionLines)
  cache.result.code.additionLines.length = 0
  renderer.beginEditSession(session, external)
  expect(cache.result.code.additionLines).toHaveLength(0)
  expect(result.code.additionLines).toHaveLength(1)
})

it('does not adopt a worker result without the editor token transformer', () => {
  const external = {
    name: 'file.ts',
    cacheKey: 'external',
    additionLines: ['new\n']
  } as FileDiffMetadata
  const worker = {
    isWorkingPool: () => true,
    getDiffRenderOptions: () => ({ theme: 'dark-plus', useTokenTransformer: true }),
    getDiffResultCache: () => ({
      options: { theme: 'dark-plus', useTokenTransformer: false },
      result: {}
    })
  } as unknown as WorkerPoolManager
  const renderer = new DiffHunksRenderer({}, undefined, undefined, worker)
  renderer.beginEditSession({ ...external, cacheKey: 'session' }, external)
  expect(renderer.editorRenderReady()).toBe(false)
})
