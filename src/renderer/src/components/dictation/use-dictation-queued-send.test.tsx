// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import type { DictationSession } from '../../../../shared/dictation-session-machine'
import type { DictationKeptRecording } from './dictation-kept-recording'
import { useDictationQueuedSend, useSendAfterDictation } from './use-dictation-queued-send'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Chat(props: {
  autoSendTo: string
  onSend: () => void
  sessionRef: RefObject<DictationSession>
  keptRef: RefObject<DictationKeptRecording | null>
  ownerRef: { current: ReturnType<typeof useDictationQueuedSend> | null }
  rootRef: RefObject<HTMLDivElement | null>
}) {
  props.ownerRef.current = useDictationQueuedSend(props.sessionRef, props.keptRef)
  useSendAfterDictation(props.rootRef, props.onSend, props.autoSendTo)
  return (
    <div ref={props.rootRef}>
      <textarea />
    </div>
  )
}

/** A recording into the chat for session-a, still listening; `stop` ends it and starts its countdown. */
async function dictateIntoSessionA() {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      voice: {
        ...getDefaultVoiceSettings(),
        enabled: true,
        autoSendAfterDictation: true,
        autoSendDelayMs: 1000
      }
    }
  })
  const sessionRef: RefObject<DictationSession> = {
    current: { phase: 'listening', run: 1, sessionId: '1', heardFinalText: true }
  }
  const keptRef: RefObject<DictationKeptRecording | null> = { current: null }
  const ownerRef: { current: ReturnType<typeof useDictationQueuedSend> | null } = { current: null }
  const rootRef: RefObject<HTMLDivElement | null> = { current: null }
  const props = { onSend: vi.fn(), sessionRef, keptRef, ownerRef, rootRef }
  const view = render(<Chat autoSendTo="session-a" {...props} />)
  const root = rootRef.current!
  keptRef.current = {
    chunks: [],
    complete: true,
    cutOff: false,
    context: {},
    target: { kind: 'composer', root, insert: () => true },
    deliver: Object.assign(() => {}, {
      landedText: () => '',
      settled: async () => true,
      held: () => null,
      releaseHeld: () => {},
      hold: () => {}
    })
  }
  root.querySelector('textarea')!.focus()
  const owner = () => ownerRef.current!
  return {
    onSend: props.onSend,
    owner,
    switchTo: (autoSendTo: string) => view.rerender(<Chat autoSendTo={autoSendTo} {...props} />),
    stop: async () => {
      sessionRef.current = { ...sessionRef.current, phase: 'stopping' }
      owner().follow(sessionRef.current)
      void owner().release(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
    },
    waitPastDeadline: () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
  }
}

it('never sends a recording to a chat that replaced its own before dictation stopped', async () => {
  const chat = await dictateIntoSessionA()
  chat.switchTo('session-b')
  await chat.stop()
  expect(chat.owner().autoSend).toBeNull()
  await chat.waitPastDeadline()
  expect(chat.onSend).not.toHaveBeenCalled()
})

it('never sends a recording to a chat that replaced its own during the countdown', async () => {
  const chat = await dictateIntoSessionA()
  await chat.stop()
  expect(chat.owner().autoSend).not.toBeNull()
  chat.switchTo('session-b')
  await chat.waitPastDeadline()
  expect(chat.owner().autoSend).toBeNull()
  expect(chat.onSend).not.toHaveBeenCalled()
})
