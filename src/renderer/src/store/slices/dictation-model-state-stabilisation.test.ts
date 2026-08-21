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
