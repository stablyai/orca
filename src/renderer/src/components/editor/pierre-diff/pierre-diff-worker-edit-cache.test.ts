import { DiffHunksRenderer, parseDiffFromFile, type ThemedDiffResult } from '@pierre/diffs'
import type { WorkerPoolManager } from '@pierre/diffs/worker'
import { expect, it, vi } from 'vitest'

it('starts editing from a worker result and gives the editor its own mutable line array', () => {
  const options = { theme: 'dark-plus', useTokenTransformer: true }
  const external = {
    ...parseDiffFromFile(null, { name: 'file.ts', contents: 'new\n' }),
    cacheKey: 'external'
  }
  const session = { ...external, cacheKey: 'session' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache-adoption seam uses only these worker/result fields; no highlighting or DOM render runs.
  const result = {
    code: { additionLines: [{ type: 'element' }], deletionLines: [] }
  } as unknown as ThemedDiffResult
  const decode = vi.fn(() => ({ type: 'element' }))
  Object.defineProperty(result.code.additionLines, 0, {
    get: decode,
    configurable: true,
    enumerable: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache-adoption seam uses only these worker/result fields; no highlighting or DOM render runs.
  const worker = {
    isWorkingPool: () => true,
    getDiffRenderOptions: () => options,
    getDiffResultCache: vi.fn(() => ({ options, result }))
  } as unknown as WorkerPoolManager
  const renderer = new DiffHunksRenderer({}, undefined, undefined, worker)
  renderer.beginEditSession(session, external)
  expect(renderer.editorRenderReady()).toBe(true)
  expect(decode).not.toHaveBeenCalled()
  expect(renderer.diffCache).toBe(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache-adoption seam uses only these worker/result fields; no highlighting or DOM render runs.
  const cache = (renderer as unknown as { renderCache: { result: ThemedDiffResult } }).renderCache
  expect(cache.result.code.additionLines === result.code.additionLines).toBe(false)
  cache.result.code.additionLines[0] = { type: 'text', value: 'edited' }
  expect(decode).not.toHaveBeenCalled()
  expect(result.code.additionLines[0]).toEqual({ type: 'element' })
  cache.result.code.additionLines.length = 0
  renderer.beginEditSession(session, external)
  expect(cache.result.code.additionLines).toHaveLength(0)
  expect(result.code.additionLines).toHaveLength(1)
})

it('does not adopt a worker result without the editor token transformer', () => {
  const external = {
    ...parseDiffFromFile(null, { name: 'file.ts', contents: 'new\n' }),
    cacheKey: 'external'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache-adoption seam uses only these worker/result fields; no highlighting or DOM render runs.
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

it('updates whitespace-ignoring replacement hunks incrementally until an edit matches the original', () => {
  const options = { theme: 'dark-plus', useTokenTransformer: true }
  const original = 'const original = 1\nconst second = 2\n'
  const modified = 'const changed = 3\nconst current = 4\n'
  const external = {
    ...parseDiffFromFile(
      { name: 'file.ts', contents: original },
      { name: 'file.ts', contents: modified },
      { ignoreWhitespace: true }
    ),
    cacheKey: 'external'
  }
  const session = { ...external, additionLines: [...external.additionLines], cacheKey: 'session' }
  const result: ThemedDiffResult = {
    code: { additionLines: [], deletionLines: [] },
    themeStyles: '',
    baseThemeType: undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only cache reads run; no worker is dispatched by this edit-session test.
  const worker = {
    isWorkingPool: () => true,
    getDiffRenderOptions: () => options,
    getDiffResultCache: () => ({ options, result })
  } as unknown as WorkerPoolManager
  const renderer = new DiffHunksRenderer(
    { parseDiffOptions: { ignoreWhitespace: true } },
    undefined,
    undefined,
    worker
  )
  renderer.beginEditSession(session, external)
  const hunks = session.hunks
  renderer.updateRenderCache(new Map(), 'dark', false, new Map([[1, 'const current = 45\n']]), 3)
  expect(session.hunks).toBe(hunks)
  expect(session.additionLines[1]).toBe('const current = 45\n')
  renderer.updateRenderCache(new Map(), 'dark', false, new Map([[1, '  const second = 2  \n']]), 3)
  expect(session.hunks).not.toBe(hunks)
  expect(session.hunks.flatMap((hunk) => hunk.hunkContent)).toContainEqual(
    expect.objectContaining({ type: 'context', lines: 1 })
  )
  expect(external.additionLines.join('')).toBe(modified)
})
