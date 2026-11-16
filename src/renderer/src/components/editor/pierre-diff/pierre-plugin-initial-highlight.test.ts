// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'

const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }))
vi.mock('./pierre-diff-parse.worker?worker', () => ({ default: class {} }))
vi.mock('./pierre-diff-parse-scheduler', () => ({
  createPierreDiffParseScheduler: () => ({ request: schedule, dispose: vi.fn() })
}))
vi.mock('./pierre-diff-highlight', () => ({
  preparePierreDiffHighlight: () => Promise.reject(new Error('worker stopped'))
}))
import { requestPierreFileDiff } from './pierre-diff-parse-client'

it('enters edit mode with plain highlighting when the initial plugin worker fails', async () => {
  const diff = {
    ...parseDiffFromFile(
      { name: 'file.custom', contents: 'old' },
      { name: 'file.custom', contents: 'new' }
    ),
    lang: 'orca-plugin-syntax-1'
  }
  schedule.mockResolvedValue(diff)
  const result = await requestPierreFileDiff(
    {
      path: 'file.custom',
      status: 'modified',
      originalContent: 'old',
      modifiedContent: 'new',
      parseDiffOptions: {}
    },
    new AbortController().signal,
    true
  )
  expect(result.lang).toBe('text')
  expect(result.additionLines).toEqual(['new'])
  expect(result.deletionLines).toEqual(['old'])
})
