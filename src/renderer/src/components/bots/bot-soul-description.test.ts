// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

import { getDiskBaselineSignature } from '../../../../shared/file-write/disk-baseline-signature'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/autosave/editor-autosave'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { useAppStore } from '@/store'
import { makeOpenFile } from '@/store/slices/editor/types/open-file.test-fixture'
import { writeBotHomeFile, type BotHome } from '../settings/bots/bot-home-files'
import { useBotSoulDescription } from './bot-soul-description'

const soul = (purpose: string): string => `# CoS\n\n${purpose}\n`
const local = (folderPath = '/bots/cos'): BotHome => ({
  bot: { hostId: 'local', folderWorkspaceId: 'fw-cos' },
  folderPath
})
const PAIRED_HOST = 'runtime:env-1'
const paired: BotHome = {
  bot: { hostId: PAIRED_HOST, folderWorkspaceId: 'fw-cos' },
  folderPath: '/bots/cos'
}
const OVERWRITE = { expectedSignature: getDiskBaselineSignature(''), allowMissing: true }

const readFile = vi.fn()
const writeFile = vi.fn()
// What the paired server's SOUL.md read answers; a function may throw, as a down server does.
let serverSoul: () => string = () => soul('On the server')

beforeEach(() => {
  readFile.mockReset()
  writeFile.mockReset().mockResolvedValue({ ok: true })
  serverSoul = () => soul('On the server')
  callRuntimeRpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'status.get') {
      return createCompatibleRuntimeStatusResponse('env-1').result
    }
    return method === 'files.read' ? { content: serverSoul() } : { ok: true }
  })
  vi.stubGlobal('api', { fs: { readFile, writeFile } })
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: PAIRED_HOST, state: 'live' }
    ],
    updateNeeded: []
  })
  useAppStore.setState({ openFiles: [] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function editorSaved(file: { id: string; runtimeEnvironmentId: string | null }, content: string) {
  useAppStore.setState({
    openFiles: [
      makeOpenFile({
        id: file.id,
        worktreeId: 'folder:fw-cos',
        filePath: '/bots/cos/SOUL.md',
        relativePath: 'SOUL.md',
        runtimeEnvironmentId: file.runtimeEnvironmentId
      })
    ]
  })
  window.dispatchEvent(
    new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, {
      detail: { fileId: file.id, content, recordViewIds: [file.id] }
    })
  )
}

describe('useBotSoulDescription', () => {
  it("reads a paired bot's SOUL.md on its own server, not this computer's file at that path", async () => {
    readFile.mockResolvedValue({ content: soul('This computer’s bot at the same path') })
    serverSoul = () => soul('Runs the team’s week on the server')
    const { result } = renderHook(() => useBotSoulDescription(paired))
    await waitFor(() => expect(result.current).toBe('Runs the team’s week on the server'))
    expect(callRuntimeRpc.mock.calls[0][0]).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('shows a SOUL.md save at once, without remounting', async () => {
    readFile.mockResolvedValue({ content: soul('Old purpose') })
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await waitFor(() => expect(result.current).toBe('Old purpose'))
    await act(() => writeBotHomeFile(local(), 'SOUL.md', soul('New purpose'), OVERWRITE))
    expect(result.current).toBe('New purpose')
  })

  it("takes a save only on its own host's SOUL.md at its own folder", async () => {
    readFile.mockResolvedValue({ content: soul('Mine') })
    const here = renderHook(() => useBotSoulDescription(local()))
    const there = renderHook(() => useBotSoulDescription(paired))
    await waitFor(() => expect(here.result.current).toBe('Mine'))
    await waitFor(() => expect(there.result.current).toBe('On the server'))
    let serverSave: unknown = null
    await act(async () => {
      serverSave = await writeBotHomeFile(paired, 'SOUL.md', soul('The server bot'), OVERWRITE)
      await writeBotHomeFile(local('/bots/docs'), 'SOUL.md', soul('Docs'), OVERWRITE)
      await writeBotHomeFile(local(), 'MEMORY.md', soul('A memory'), OVERWRITE)
    })
    // The same path on the server really saved, there and not on this computer, and only the server's bot took it.
    expect(serverSave).toEqual({ ok: true })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-1' }),
      // files.write, or files.writeIfUnchanged on a host that checks the baseline itself.
      expect.stringMatching(/^files\.write/),
      expect.objectContaining({ content: soul('The server bot') }),
      expect.anything()
    )
    expect(writeFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: soul('The server bot') })
    )
    expect(there.result.current).toBe('The server bot')
    expect(here.result.current).toBe('Mine')
  })

  it('keeps a save over a read that started before it', async () => {
    let finishRead: (value: { content: string }) => void = () => {}
    readFile.mockReturnValue(new Promise((resolve) => (finishRead = resolve)))
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await act(async () => {
      await writeBotHomeFile(local(), 'SOUL.md', soul('Saved'), OVERWRITE)
      finishRead({ content: soul('Read before the save') })
    })
    expect(result.current).toBe('Saved')
  })

  it('takes only the saves that landed', async () => {
    readFile.mockResolvedValue({ content: soul('On disk') })
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await waitFor(() => expect(result.current).toBe('On disk'))
    writeFile.mockResolvedValueOnce({ ok: false, diskConflict: 'changed' })
    await act(() => writeBotHomeFile(local(), 'SOUL.md', soul('Rejected'), OVERWRITE))
    expect(result.current).toBe('On disk')
    await act(() => writeBotHomeFile(local(), 'SOUL.md', soul('Accepted'), OVERWRITE))
    expect(result.current).toBe('Accepted')
  })

  it('shows a save from SOUL.md’s editor tab on its own host', async () => {
    readFile.mockResolvedValue({ content: soul('Before the tab') })
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await waitFor(() => expect(result.current).toBe('Before the tab'))
    act(() =>
      editorSaved({ id: 'soul-tab', runtimeEnvironmentId: null }, soul('Edited in the tab'))
    )
    expect(result.current).toBe('Edited in the tab')
    // The same path saved on the server is another file.
    act(() => editorSaved({ id: 'server-tab', runtimeEnvironmentId: 'env-1' }, soul('Server tab')))
    expect(result.current).toBe('Edited in the tab')
  })

  it('reads again when Orca regains focus, for an edit made outside it', async () => {
    readFile.mockResolvedValueOnce({ content: soul('Before') })
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await waitFor(() => expect(result.current).toBe('Before'))
    readFile.mockResolvedValueOnce({ content: soul('Changed in another app') })
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(result.current).toBe('Changed in another app'))
  })

  it('keeps only the newest of overlapping reads', async () => {
    readFile.mockResolvedValueOnce({ content: soul('First') })
    const { result } = renderHook(() => useBotSoulDescription(local()))
    await waitFor(() => expect(result.current).toBe('First'))
    let finishOlder: (value: { content: string }) => void = () => {}
    readFile
      .mockReturnValueOnce(new Promise((resolve) => (finishOlder = resolve)))
      .mockResolvedValueOnce({ content: soul('Newest') })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current).toBe('Newest'))
    await act(async () => finishOlder({ content: soul('Older') }))
    expect(result.current).toBe('Newest')
  })

  it('reads again when its server comes back after a failed read', async () => {
    serverSoul = () => {
      throw new Error('server unreachable')
    }
    const { result } = renderHook(() => useBotSoulDescription(paired))
    await waitFor(() => expect(callRuntimeRpc).toHaveBeenCalled())
    expect(result.current).toBeNull()
    const goes = (state: 'live' | 'offline') =>
      setBotHostListing({
        hosts: [
          { hostId: 'local', state: 'live' },
          { hostId: PAIRED_HOST, state }
        ],
        updateNeeded: []
      })
    act(() => void goes('offline'))
    serverSoul = () => soul('Back on the server')
    act(() => void goes('live'))
    await waitFor(() => expect(result.current).toBe('Back on the server'))
  })
})
