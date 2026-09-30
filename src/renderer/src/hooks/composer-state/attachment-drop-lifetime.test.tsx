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
const authorize = vi.fn(async (_input: { targetPath: string }) => {})
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
  authorize.mockReset().mockResolvedValue(undefined)
  stat.mockReset().mockResolvedValue({ isDirectory: false })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { authorizeExternalPath: authorize, stat },
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

describe('local composer drop lifetime', () => {
  it.each(['authorize', 'stat'] as const)(
    'stops a large batch after unmount during %s',
    async (phase) => {
      const gate = Promise.withResolvers<void>()
      if (phase === 'authorize') {
        authorize.mockImplementationOnce(() => gate.promise)
      } else {
        stat.mockImplementationOnce(async () => {
          await gate.promise
          return { isDirectory: false }
        })
      }
      const hook = renderDrop()
      const paths = Array.from({ length: 1000 }, (_, index) => `/drop/item-${index}`)
      const pending = hook.result.current.applyLocalComposerDrop(paths)
      await vi.waitFor(() =>
        expect(phase === 'authorize' ? authorize : stat).toHaveBeenCalledOnce()
      )
      hook.unmount()
      gate.resolve()
      await pending

      expect(authorize).toHaveBeenCalledOnce()
      expect(stat).toHaveBeenCalledTimes(phase === 'authorize' ? 0 : 1)
      expect(hook.attach).not.toHaveBeenCalled()
      expect(hook.prompt).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it.each(['authorize', 'stat'] as const)(
    'stops silently when a held %s fails after unmount',
    async (phase) => {
      const gate = Promise.withResolvers<never>()
      if (phase === 'authorize') {
        authorize.mockImplementationOnce(() => gate.promise)
      } else {
        stat.mockImplementationOnce(() => gate.promise)
      }
      const hook = renderDrop()
      const pending = hook.result.current.applyLocalComposerDrop(['/drop/one', '/drop/two'])
      await vi.waitFor(() =>
        expect(phase === 'authorize' ? authorize : stat).toHaveBeenCalledOnce()
      )
      hook.unmount()
      gate.reject(new Error('EACCES: no access'))
      await pending

      expect(authorize).toHaveBeenCalledOnce()
      expect(stat).toHaveBeenCalledTimes(phase === 'authorize' ? 0 : 1)
      expect(hook.attach).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it('does no work through a callback saved before unmount', async () => {
    const hook = renderDrop()
    const applyDrop = hook.result.current.applyLocalComposerDrop
    hook.unmount()
    await applyDrop(['/drop/late'])

    expect(authorize).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(hook.attach).not.toHaveBeenCalled()
  })

  it('keeps the current request pending until it settles', async () => {
    const gate = Promise.withResolvers<void>()
    authorize.mockImplementationOnce(() => gate.promise)
    const hook = renderDrop()
    const settled = vi.fn()
    const pending = hook.result.current.applyLocalComposerDrop(['/drop/one']).then(settled)
    hook.unmount()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    gate.resolve()
    await pending
    expect(settled).toHaveBeenCalledOnce()
    expect(stat).not.toHaveBeenCalled()
  })

  it('preserves mixed results, order, duplicate filtering and one failure report', async () => {
    const order: string[] = []
    authorize.mockImplementation(async ({ targetPath }) => {
      order.push(`authorize:${targetPath}`)
    })
    stat.mockImplementation(async ({ filePath }) => {
      order.push(`stat:${filePath}`)
      if (filePath === '/drop/missing') {
        throw new Error('ENOENT: missing')
      }
      return { isDirectory: filePath === '/drop/folder' }
    })
    const hook = renderDrop()
    const paths = ['/drop/one', '/drop/folder', '/drop/missing', '/drop/two', '/drop/one']
    await hook.result.current.applyLocalComposerDrop(paths)

    expect(order).toEqual(paths.flatMap((path) => [`authorize:${path}`, `stat:${path}`]))
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
      authorize.mockImplementationOnce(() => gate.promise)
      const hook = renderDrop(strict)
      act(() => nativeDrop(['/drop/one', '/drop/two']))
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
      hook.unmount()
      expect(listeners.size).toBe(0)
      await act(async () => gate.resolve())

      expect(authorize).toHaveBeenCalledOnce()
      expect(stat).not.toHaveBeenCalled()
      expect(hook.attach).not.toHaveBeenCalled()
    }
  )

  it('continues while temporarily covered and applies if ownership returns', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    authorize
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => first.resolve())
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(stat).toHaveBeenCalledOnce()
    expect(older.attach).not.toHaveBeenCalled()
    newer.unmount()
    await act(async () => second.resolve())

    expect(older.attach).toHaveBeenCalledOnce()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('withholds a completed drop while a newer owner remains mounted', async () => {
    const gate = Promise.withResolvers<void>()
    authorize.mockImplementationOnce(() => gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/one', '/drop/two']))
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    const newer = renderDrop()
    await act(async () => gate.resolve())

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(stat).toHaveBeenCalledTimes(2)
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).not.toHaveBeenCalled()
  })

  it('does not revive an old batch when another composer mounts', async () => {
    const gate = Promise.withResolvers<void>()
    authorize.mockImplementationOnce(() => gate.promise)
    const older = renderDrop()
    act(() => nativeDrop(['/drop/old-one', '/drop/old-two']))
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    older.unmount()
    const newer = renderDrop()
    await act(async () => {
      nativeDrop(['/drop/new'])
      gate.resolve()
    })

    expect(authorize.mock.calls.map(([input]) => input.targetPath)).toEqual([
      '/drop/old-one',
      '/drop/new'
    ])
    expect(stat.mock.calls.map(([input]) => input.filePath)).toEqual(['/drop/new'])
    expect(older.attach).not.toHaveBeenCalled()
    expect(newer.attach).toHaveBeenCalledOnce()
  })
})
