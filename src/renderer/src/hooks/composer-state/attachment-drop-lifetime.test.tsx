// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeFileDropPayload } from '../../../../shared/native-file-drop'
import { useAttachmentDropState } from './attachment-drop-state'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/runtime-file-client', () => ({ importExternalPathsToRuntime: vi.fn() }))

const listeners = new Set<(data: NativeFileDropPayload) => void>()
const stat = vi.fn(async (_input: { filePath: string }) => ({ isDirectory: false }))
let originalApi: PropertyDescriptor | undefined

function renderDrop(strict = false) {
  const attach = vi.fn()
  const prompt = vi.fn()
  const hook = renderHook(
    () =>
      useAttachmentDropState({
        agentPromptRef: { current: '' },
        cancelPromptCaretFrame: () => {},
        connectionId: null,
        promptCaretFrameRef: { current: null },
        promptTextareaRef: createRef<HTMLTextAreaElement>(),
        selectedRepoPath: '/folder-workspace',
        selectedRepoSettings: null,
        setAgentPrompt: prompt,
        setAttachmentPaths: attach
      }),
    { wrapper: strict ? StrictMode : undefined }
  )
  return { ...hook, attach, prompt }
}

function nativeDrop(paths: string[]): void {
  for (const listener of listeners) {
    listener({ target: 'composer', paths })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  stat.mockReset().mockResolvedValue({ isDirectory: false })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { stat },
      ui: {
        onFileDrop: (listener: (data: NativeFileDropPayload) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  expect(listeners.size).toBe(0)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function holdStat(gate: Promise<void>): void {
  stat.mockImplementationOnce(async () => {
    await gate
    return { isDirectory: false }
  })
}

describe('local composer drop lifetime', () => {
  it('stops a large batch after unmount during a file check', async () => {
    const gate = Promise.withResolvers<void>()
    holdStat(gate.promise)
    const hook = renderDrop()
    const paths = Array.from({ length: 1000 }, (_, index) => `/drop/item-${index}`)
    const pending = hook.result.current.applyLocalComposerDrop(paths)
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    hook.unmount()
    gate.resolve()
    await pending

    expect(stat).toHaveBeenCalledOnce()
    expect(hook.attach).not.toHaveBeenCalled()
    expect(hook.prompt).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('stops silently when a held file check fails after unmount', async () => {
    const gate = Promise.withResolvers<never>()
    stat.mockImplementationOnce(() => gate.promise)
    const hook = renderDrop()
    const pending = hook.result.current.applyLocalComposerDrop(['/drop/one', '/drop/two'])
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    hook.unmount()
    gate.reject(new Error('EACCES: no access'))
    await pending

    expect(stat).toHaveBeenCalledOnce()
    expect(hook.attach).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does no work through a callback saved before unmount', async () => {
    const hook = renderDrop()
    const applyDrop = hook.result.current.applyLocalComposerDrop
    hook.unmount()
    await applyDrop(['/drop/late'])

    expect(stat).not.toHaveBeenCalled()
    expect(hook.attach).not.toHaveBeenCalled()
  })

  it('checks each dropped path as user-named, keeping results, order and one failure report', async () => {
    const order: string[] = []
    stat.mockImplementation(async ({ filePath }) => {
      order.push(filePath)
      if (filePath === '/drop/missing') {
        throw new Error('ENOENT: missing')
      }
      return { isDirectory: filePath === '/drop/folder' }
    })
    const hook = renderDrop()
    const paths = ['/drop/one', '/drop/folder', '/drop/missing', '/drop/two', '/drop/one']
    await hook.result.current.applyLocalComposerDrop(paths)

    expect(order).toEqual(paths)
    expect(stat).toHaveBeenCalledWith({ filePath: '/drop/one', access: { kind: 'user-file' } })
    expect(hook.attach).toHaveBeenCalledOnce()
    expect(hook.attach.mock.calls[0]?.[0](['/existing'])).toEqual([
      '/existing',
      '/drop/one',
      '/drop/two'
    ])
    expect(hook.prompt).toHaveBeenCalledWith('/drop/folder')
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      '1 of 5 items could not be attached.',
      { id: 'composer-drop-failure', description: 'No longer at its original path.' }
    )
  })
})

describe('native composer ownership during a local drop', () => {
  it.each([false, true])(
    'stops after actual listener cleanup (Strict Mode: %s)',
    async (strict) => {
      const gate = Promise.withResolvers<void>()
      holdStat(gate.promise)
      const hook = renderDrop(strict)
      act(() => nativeDrop(['/drop/one', '/drop/two']))
      await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
      hook.unmount()
      expect(listeners.size).toBe(0)
      await act(async () => gate.resolve())

      expect(stat).toHaveBeenCalledOnce()
      expect(hook.attach).not.toHaveBeenCalled()
    }
  )

  it('continues while temporarily covered and applies if ownership returns', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    holdStat(first.promise)
    holdStat(second.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => first.resolve())
    expect(stat).toHaveBeenCalledTimes(2)
    expect(older.attach).not.toHaveBeenCalled()
    newer.unmount()
    await act(async () => second.resolve())

    expect(older.attach).toHaveBeenCalledOnce()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('withholds a completed drop while a newer owner remains mounted', async () => {
    const gate = Promise.withResolvers<void>()
    holdStat(gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => gate.resolve())

    expect(stat).toHaveBeenCalledTimes(2)
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('does not revive an old batch when another composer mounts', async () => {
    const gate = Promise.withResolvers<void>()
    holdStat(gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/old-one', '/drop/old-two']))
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    older.unmount()
    const newer = renderDrop()
    await act(async () => {
      nativeDrop(['/drop/new'])
      gate.resolve()
    })

    expect(stat.mock.calls.map(([input]) => input.filePath)).toEqual(['/drop/old-one', '/drop/new'])
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).toHaveBeenCalledOnce()
  })
})
