// @vitest-environment happy-dom

import { Activity, useSyncExternalStore, type RefObject } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DictationSession } from './dictation-session-machine'
import {
  createDictationKeptRecording,
  type DictationKeptRecording
} from './dictation-kept-recording'
import { createDictationTranscriptDelivery } from './dictation-transcript-delivery'
import { useDictationQueuedSend, useSendAfterDictation } from './use-dictation-queued-send'

afterEach(cleanup)

it('sends once the words land even when the chat was hidden after Enter', async () => {
  let draft = ''
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const sent = vi.fn<(text: string) => void>()
  const root = { current: document.createElement('div') }
  const sessionRef: RefObject<DictationSession> = {
    current: { phase: 'listening', run: 1, sessionId: 'session', heardFinalText: false }
  }
  const keptRef: RefObject<DictationKeptRecording | null> = { current: null }
  let release = async (_run: number): Promise<void> => {}
  let send = (): void => {}

  function Controller(): null {
    release = useDictationQueuedSend(sessionRef, keptRef).release
    return null
  }
  function Composer(): null {
    const text = useSyncExternalStore(subscribe, () => draft)
    send = useSendAfterDictation(root, () => sent(text))
    return null
  }
  const app = (visible: boolean): React.JSX.Element => (
    <>
      <Controller />
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <Composer />
      </Activity>
    </>
  )

  const { rerender } = render(app(true))
  const target = {
    kind: 'composer' as const,
    root: root.current,
    insert: (text: string) => {
      draft = text
      listeners.forEach((listener) => listener())
      return true
    }
  }
  const deliver = createDictationTranscriptDelivery()
  keptRef.current = createDictationKeptRecording(target, deliver, {})
  act(() => send())
  expect(sent).not.toHaveBeenCalled()

  rerender(app(false))
  deliver('Reply only with the word mango.', target)
  await act(() => release(1))
  expect(sent.mock.calls).toEqual([['Reply only with the word mango.']])

  rerender(app(true))
  await act(async () => {})
  expect(sent).toHaveBeenCalledTimes(1)
})
