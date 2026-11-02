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
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: (...args: unknown[]) => mocks.importExternalPaths(...args)
}))

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
      selectedRepoRuntimeEnvironmentId: null,
      selectedWorktreeId: null,
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
})
