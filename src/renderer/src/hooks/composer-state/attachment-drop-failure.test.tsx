// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), importExternalPaths: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: (...args: unknown[]) => mocks.importExternalPaths(...args)
}))

vi.mock('./composer-drop-listener', () => ({ useComposerDropListener: vi.fn() }))

import { useAttachmentDropState } from './attachment-drop-state'

const FAILING_PATHS = new Set(['/drop/bad-1.png', '/drop/bad-2.png', '/drop/bad-3.png'])

function dropPaths(count: number): string[] {
  return [
    ...FAILING_PATHS,
    ...Array.from({ length: count - FAILING_PATHS.size }, (_, index) => `/drop/ok-${index}.png`)
  ]
}

function installFsApi(): void {
  Object.assign(window, {
    api: {
      fs: {
        authorizeExternalPath: vi.fn(async () => {}),
        stat: vi.fn(async ({ filePath }: { filePath: string }) => {
          if (FAILING_PATHS.has(filePath)) {
            throw new Error(
              "Error invoking remote method 'fs:stat': Error: ENOENT: no such file or directory"
            )
          }

          return { isDirectory: false }
        })
      }
    }
  })
}

function renderDropState(setAttachmentPaths: Dispatch<SetStateAction<string[]>>) {
  return renderHook(() =>
    useAttachmentDropState({
      agentPromptRef: { current: '' },
      cancelPromptCaretFrame: () => {},
      connectionId: null,
      promptCaretFrameRef: { current: null },
      promptTextareaRef: createRef<HTMLTextAreaElement>(),
      selectedRepoPath: '/repo',
      selectedRepoSettings: null,
      setAgentPrompt: () => {},
      setAttachmentPaths
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  installFsApi()
})

describe('local composer drop failures', () => {
  it('reports partially skipped paths in one aggregated toast and still attaches the rest', async () => {
    const attached: string[] = []

    const { result } = renderDropState((next) => {
      attached.push(...(typeof next === 'function' ? next([]) : next))
    })

    await act(async () => {
      await result.current.applyLocalComposerDrop(dropPaths(12))
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toastError.mock.calls[0] ?? []
    expect(title).toBe('3 of 12 items could not be attached.')
    expect(options.description).toBe('No longer at its original path.')
    expect(attached).toHaveLength(9)
    expect(attached).not.toContain('/drop/bad-1.png')
  })

  it('stays silent when every dropped path attaches', async () => {
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.applyLocalComposerDrop(['/drop/ok-0.png', '/drop/ok-1.png'])
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says nothing once the composer that owned the drop is gone', async () => {
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.applyLocalComposerDrop(dropPaths(12), () => false)
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

// Why: the upload branch returns early unless a runtime environment or connection is resolved.
const RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: 'env-1' }

describe('composer upload failures', () => {
  it('aggregates a mixed runtime import into one toast, and withholds a reason that is not shared', async () => {
    mocks.importExternalPaths.mockResolvedValue({
      results: [
        {
          sourcePath: '/a.png',
          status: 'imported',
          destPath: '/repo/.orca/drops/a.png',
          kind: 'file',
          renamed: false
        },
        { sourcePath: '/b.png', status: 'skipped', reason: 'permission-denied' },
        { sourcePath: '/c.png', status: 'failed', reason: 'disk full' }
      ]
    })
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.uploadComposerPaths(
        ['/a.png', '/b.png', '/c.png'],
        RUNTIME_SETTINGS,
        null,
        '/repo'
      )
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toastError.mock.calls[0] ?? []
    expect(title).toBe('2 of 3 items could not be attached.')
    expect(options.description).toBeUndefined()
  })

  it('stays silent when every uploaded path imports', async () => {
    mocks.importExternalPaths.mockResolvedValue({
      results: [
        {
          sourcePath: '/a.png',
          status: 'imported',
          destPath: '/repo/.orca/drops/a.png',
          kind: 'file',
          renamed: false
        }
      ]
    })
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.uploadComposerPaths(['/a.png'], RUNTIME_SETTINGS, null, '/repo')
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does not report after the composer that owned the upload is gone', async () => {
    mocks.importExternalPaths.mockResolvedValue({
      results: [{ sourcePath: '/b.png', status: 'skipped', reason: 'missing' }]
    })
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.uploadComposerPaths(
        ['/b.png'],
        RUNTIME_SETTINGS,
        null,
        '/repo',
        () => false
      )
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does give the shared reason when every uploaded path failed the same way', async () => {
    mocks.importExternalPaths.mockResolvedValue({
      results: [
        { sourcePath: '/b.png', status: 'skipped', reason: 'permission-denied' },
        { sourcePath: '/c.png', status: 'skipped', reason: 'permission-denied' }
      ]
    })
    const { result } = renderDropState(() => {})

    await act(async () => {
      await result.current.uploadComposerPaths(
        ['/b.png', '/c.png'],
        RUNTIME_SETTINGS,
        null,
        '/repo'
      )
    })

    const [, options] = mocks.toastError.mock.calls[0] ?? []
    expect(options.description).toBe('Permission denied.')
  })
})
