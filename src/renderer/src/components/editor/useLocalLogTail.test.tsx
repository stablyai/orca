// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { LocalLogTailChangedPayload } from '../../../../shared/local-log-tail-types'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import { useLocalLogTail } from './useLocalLogTail'

const FILE_PATH = '/home/user/.codex/sessions/log.jsonl'
const FILE_IDENTITY = '1:2:3'

const openFile = {
  id: FILE_PATH,
  filePath: FILE_PATH,
  relativePath: FILE_PATH,
  worktreeId: 'wt-1',
  language: 'jsonl',
  isDirty: false,
  runtimeEnvironmentId: null,
  mode: 'edit',
  readOnly: true,
  liveTail: true
} satisfies OpenFile

function encodedResult(content: string, fromByteOffset: number) {
  const bytes = Buffer.from(content)
  return {
    contentBase64: bytes.toString('base64'),
    nextByteOffset: fromByteOffset + bytes.byteLength,
    fileSize: fromByteOffset + bytes.byteLength,
    fileIdentity: FILE_IDENTITY,
    hasMore: false,
    reset: false
  }
}

let changedListener: ((payload: LocalLogTailChangedPayload) => void) | undefined
let startMock: ReturnType<typeof vi.fn>
let stopMock: ReturnType<typeof vi.fn>
let readMock: ReturnType<typeof vi.fn>
let reloadMock: Mock<(file: OpenFile) => void>
let warnMock: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  changedListener = undefined
  startMock = vi.fn().mockResolvedValue(undefined)
  stopMock = vi.fn().mockResolvedValue(undefined)
  readMock = vi.fn()
  reloadMock = vi.fn<(file: OpenFile) => void>()
  warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: {
        startLocalLogTail: startMock,
        stopLocalLogTail: stopMock,
        readLocalLogTail: readMock,
        onLocalLogTailChanged: vi.fn((listener: (payload: LocalLogTailChangedPayload) => void) => {
          changedListener = listener
          return vi.fn()
        })
      }
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
  warnMock.mockRestore()
  vi.clearAllMocks()
})

function useHarness(files: OpenFile[], initialContent: FileContent) {
  const [contents, setContents] = useState<Record<string, FileContent>>({
    [FILE_PATH]: initialContent
  })
  useLocalLogTail({
    openFiles: files,
    fileContents: contents,
    setFileContents: setContents,
    reloadContent: reloadMock
  })
  return contents
}

describe('useLocalLogTail', () => {
  it('re-reads a partial snapshot line and appends it only after completion', async () => {
    const snapshot = 'complete\n{"partial":'
    const offset = Buffer.byteLength('complete\n')
    readMock.mockResolvedValue(encodedResult('{"partial":true}\n', offset))

    const { result } = renderHook(() =>
      useHarness([openFile], {
        content: snapshot,
        isBinary: false,
        fileIdentity: FILE_IDENTITY
      })
    )

    await waitFor(() => {
      expect(result.current[FILE_PATH]?.content).toBe('complete\n{"partial":true}\n')
    })
    expect(readMock).toHaveBeenCalledWith({
      filePath: FILE_PATH,
      fromByteOffset: offset,
      expectedIdentity: FILE_IDENTITY
    })
  })

  it('waits for watcher startup before cancelling a tab closed in flight', async () => {
    let resolveStart: (() => void) | undefined
    startMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve
        })
    )
    const snapshot: FileContent = {
      content: 'complete\n',
      isBinary: false,
      fileIdentity: FILE_IDENTITY
    }
    const { rerender } = renderHook(({ files }) => useHarness(files, snapshot), {
      initialProps: { files: [openFile] }
    })

    rerender({ files: [] })
    await act(async () => resolveStart?.())

    await waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1))
    expect(readMock).not.toHaveBeenCalled()
  })

  it('falls back to a full reload when a change reveals truncation', async () => {
    readMock.mockResolvedValue({
      ...encodedResult('', 0),
      nextByteOffset: 0,
      reset: true
    })
    renderHook(() =>
      useHarness([openFile], {
        content: 'old\n',
        isBinary: false,
        fileIdentity: FILE_IDENTITY
      })
    )

    await waitFor(() => expect(reloadMock).toHaveBeenCalledWith(openFile))
    await waitFor(() => expect(stopMock).toHaveBeenCalledTimes(1))
  })

  it('commits complete lines read before a later transient chunk failure', async () => {
    const first = encodedResult('new\n', 4)
    readMock
      .mockResolvedValueOnce({ ...first, fileSize: first.fileSize + 1, hasMore: true })
      .mockRejectedValueOnce(new Error('temporary read failure'))
    const { result } = renderHook(() =>
      useHarness([openFile], {
        content: 'old\n',
        isBinary: false,
        fileIdentity: FILE_IDENTITY
      })
    )

    await waitFor(() => expect(result.current[FILE_PATH]?.content).toBe('old\nnew\n'))
    expect(reloadMock).not.toHaveBeenCalled()
  })

  it('treats a rename event as rotation and reloads without another ranged append', async () => {
    readMock.mockResolvedValue(encodedResult('', 4))
    renderHook(() =>
      useHarness([openFile], {
        content: 'old\n',
        isBinary: false,
        fileIdentity: FILE_IDENTITY
      })
    )
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1))
    const subscriptionId = startMock.mock.calls[0]?.[0].subscriptionId as string

    act(() => changedListener?.({ subscriptionId, eventType: 'rename' }))

    await waitFor(() => expect(reloadMock).toHaveBeenCalledWith(openFile))
    expect(readMock).toHaveBeenCalledTimes(1)
  })
})
