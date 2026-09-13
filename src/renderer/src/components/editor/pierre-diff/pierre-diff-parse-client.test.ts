// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { PierreDiffInput } from './pierre-diff-metadata'

const { schedule, prepare } = vi.hoisted(() => ({ schedule: vi.fn(), prepare: vi.fn() }))
vi.mock('./pierre-diff-parse.worker?worker', () => ({ default: class {} }))
vi.mock('./pierre-diff-parse-scheduler', () => ({
  createPierreDiffParseScheduler: () => ({ request: schedule, dispose: vi.fn() })
}))
vi.mock('./pierre-diff-highlight', () => ({ preparePierreDiffHighlight: prepare }))

const { requestPierreFileDiff } = await import('./pierre-diff-parse-client')

const input: PierreDiffInput = {
  path: 'file.ts',
  cacheKey: 'scope:file.ts',
  status: 'modified',
  originalContent: 'old',
  modifiedContent: 'new',
  parseDiffOptions: {}
}
const diff = { name: 'file.ts', hunks: [] }

afterEach(() => vi.resetAllMocks())

it('reports a detached highlight failure instead of swallowing it', async () => {
  schedule.mockResolvedValue(diff)
  prepare.mockRejectedValue(new Error('worker died'))
  const onHighlightError = vi.fn()
  const result = await requestPierreFileDiff(
    input,
    new AbortController().signal,
    false,
    onHighlightError
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(result).toBe(diff)
  expect(onHighlightError).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker died' }))
})

it('stays silent when the detached highlight is merely aborted', async () => {
  schedule.mockResolvedValue(diff)
  prepare.mockRejectedValue(new DOMException('Canceled', 'AbortError'))
  const onHighlightError = vi.fn()
  await requestPierreFileDiff(input, new AbortController().signal, false, onHighlightError)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(onHighlightError).not.toHaveBeenCalled()
})

it('still blocks on the highlight for an editable surface', async () => {
  schedule.mockResolvedValue(diff)
  let settled = false
  prepare.mockImplementation(
    () => new Promise<void>((resolve) => setTimeout(() => ((settled = true), resolve()), 5))
  )
  await requestPierreFileDiff(input, new AbortController().signal, true)
  expect(settled).toBe(true)
})
