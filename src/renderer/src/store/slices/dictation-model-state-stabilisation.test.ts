/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StateCreator } from 'zustand'
import type { SpeechModelState } from '../../../../shared/speech-types'
import type { AppState } from '../types'
import { createDictationSlice } from './dictation'

type DictationTestStore = Pick<AppState, 'modelStates' | 'refreshModelStates' | 'setModelStates'>
const dictationSlice = createDictationSlice as unknown as StateCreator<DictationTestStore>

let reply: SpeechModelState[]

beforeEach(() => {
  reply = []
  Object.assign(window, {
    api: {
      speech: { getModelStates: vi.fn(async () => reply.map((state) => ({ ...state }))) }
    }
  })
})

describe('dictation model-state stabilisation', () => {
  it.each(['ready', 'not-downloaded'] as const)(
    'keeps the newer %s result when an older refresh finishes last',
    async (status) => {
      const older = Promise.withResolvers<SpeechModelState[]>()
      const newer = Promise.withResolvers<SpeechModelState[]>()
      vi.mocked(window.api.speech.getModelStates)
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
      const store = create<DictationTestStore>(dictationSlice)
      const subscriber = vi.fn()
      store.subscribe(subscriber)
      const first = store.getState().refreshModelStates()
      const second = store.getState().refreshModelStates()
      const current: SpeechModelState[] = [{ id: 'openrouter-mai-transcribe-2', status }]
      newer.resolve(current)
      await second
      older.resolve([
        { id: current[0].id, status: status === 'ready' ? 'not-downloaded' : 'ready' }
      ])
      await first

      expect(store.getState().modelStates).toBe(current)
      expect(subscriber).toHaveBeenCalledTimes(1)
    }
  )

  it('invalidates an in-flight refresh even when an explicit update is unchanged', async () => {
    const older = Promise.withResolvers<SpeechModelState[]>()
    vi.mocked(window.api.speech.getModelStates).mockReturnValueOnce(older.promise)
    const store = create<DictationTestStore>(dictationSlice)
    const current: SpeechModelState[] = [{ id: 'openrouter-mai-transcribe-2', status: 'ready' }]
    store.getState().setModelStates(current)
    const pending = store.getState().refreshModelStates()
    store.getState().setModelStates(current.map((state) => ({ ...state })))
    older.resolve([{ id: current[0].id, status: 'not-downloaded' }])
    await pending

    expect(store.getState().modelStates).toBe(current)
  })

  it('sequences refreshes independently for each store', async () => {
    const firstReply = Promise.withResolvers<SpeechModelState[]>()
    const secondReply = Promise.withResolvers<SpeechModelState[]>()
    vi.mocked(window.api.speech.getModelStates)
      .mockReturnValueOnce(firstReply.promise)
      .mockReturnValueOnce(secondReply.promise)
    const firstStore = create<DictationTestStore>(dictationSlice)
    const secondStore = create<DictationTestStore>(dictationSlice)
    const first = firstStore.getState().refreshModelStates()
    const second = secondStore.getState().refreshModelStates()
    const states: SpeechModelState[] = [{ id: 'openrouter-mai-transcribe-2', status: 'ready' }]
    secondReply.resolve(states)
    await second
    firstReply.resolve(states)
    await first

    expect(firstStore.getState().modelStates).toEqual(states)
    expect(secondStore.getState().modelStates).toEqual(states)
  })

  it('does not publish an unchanged reply', async () => {
    reply = [{ id: 'whisper-tiny', status: 'downloading', progress: 0.42 }]
    const store = create<DictationTestStore>(dictationSlice)
    await store.getState().refreshModelStates()
    const previous = store.getState()
    const subscriber = vi.fn()
    store.subscribe(subscriber)

    await store.getState().refreshModelStates()

    expect(store.getState()).toBe(previous)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it.each([
    { changed: [{ id: 'whisper-tiny', status: 'downloading', progress: 0.43 }] },
    { changed: [{ id: 'whisper-tiny', status: 'ready' }] },
    { changed: [{ id: 'whisper-tiny', status: 'error', error: 'boom' }] },
    {
      changed: [{ id: 'parakeet-tdt-0.6b-v3-int8', status: 'downloading', progress: 0.42 }]
    },
    {
      changed: [
        { id: 'whisper-tiny', status: 'downloading', progress: 0.42 },
        { id: 'parakeet-tdt-0.6b-v3-int8', status: 'not-downloaded' }
      ]
    }
  ] as { changed: SpeechModelState[] }[])('publishes a changed reply', async ({ changed }) => {
    const store = create<DictationTestStore>(dictationSlice)
    store.getState().setModelStates([{ id: 'whisper-tiny', status: 'downloading', progress: 0.42 }])
    const subscriber = vi.fn()
    store.subscribe(subscriber)

    reply = changed
    await store.getState().refreshModelStates()

    expect(store.getState().modelStates).toEqual(changed)
    expect(subscriber).toHaveBeenCalledTimes(1)
  })
})
