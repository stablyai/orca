// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'
import { useBotHomeFile } from './use-bot-home-file'

const HOME = { bot: { hostId: 'local' as const, folderWorkspaceId: 'fw-bot' }, folderPath: '/bot' }

const readFile = vi.fn()
const writeFile = vi.fn()

beforeEach(() => {
  readFile.mockReset()
  writeFile.mockReset()
  vi.stubGlobal('api', { fs: { readFile, writeFile } })
})
afterEach(() => vi.unstubAllGlobals())

describe('useBotHomeFile', () => {
  it('runs writes in order, each conditioned on its own base', async () => {
    readFile.mockResolvedValue({ content: 'a' })
    writeFile.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useBotHomeFile(HOME, 'SOUL.md'))
    await waitFor(() => expect(result.current.disk).toBe('a'))
    let outcomes: string[] = []
    await act(async () => {
      outcomes = await Promise.all([result.current.write('b', 'a'), result.current.write('c', 'b')])
    })
    expect(outcomes).toEqual(['saved', 'saved'])
    expect(writeFile.mock.calls.map(([args]) => args.diskPrecondition.expectedSignature)).toEqual([
      getDiskBaselineSignature('a'),
      getDiskBaselineSignature('b')
    ])
    expect(result.current.disk).toBe('c')
  })

  it('drops a read that overlapped a write', async () => {
    readFile.mockResolvedValueOnce({ content: 'a' })
    const { result } = renderHook(() => useBotHomeFile(HOME, 'SOUL.md'))
    await waitFor(() => expect(result.current.disk).toBe('a'))
    let finishRead: (value: { content: string }) => void = () => {}
    readFile.mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)))
    writeFile.mockResolvedValue({ ok: true })
    await act(async () => {
      const read = result.current.refresh()
      await result.current.write('b', 'a')
      finishRead({ content: 'a' })
      await read
    })
    expect(result.current.disk).toBe('b')
  })

  it('keeps only the newest of overlapping reads', async () => {
    readFile.mockResolvedValueOnce({ content: 'a' })
    const { result } = renderHook(() => useBotHomeFile(HOME, 'SOUL.md'))
    await waitFor(() => expect(result.current.disk).toBe('a'))
    let finishOlder: (value: { content: string }) => void = () => {}
    readFile
      .mockReturnValueOnce(new Promise((resolve) => (finishOlder = resolve)))
      .mockResolvedValueOnce({ content: 'newest' })
    await act(async () => {
      const older = result.current.refresh()
      await result.current.refresh()
      finishOlder({ content: 'older' })
      await older
    })
    expect(result.current.disk).toBe('newest')
  })

  it('re-reads and reports a write the bot beat', async () => {
    readFile.mockResolvedValueOnce({ content: 'a' }).mockResolvedValueOnce({ content: 'theirs' })
    writeFile.mockResolvedValue({ ok: false, diskConflict: 'changed' })
    const { result } = renderHook(() => useBotHomeFile(HOME, 'SOUL.md'))
    await waitFor(() => expect(result.current.disk).toBe('a'))
    let outcome = ''
    await act(async () => {
      outcome = await result.current.write('mine', 'a')
    })
    expect(outcome).toBe('changed-on-disk')
    expect(result.current.disk).toBe('theirs')
  })
})
