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

it('never sends a dictated draft to the conversation that replaced the one it was dictated into', async () => {
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
    current: { phase: 'stopping', run: 1, sessionId: '1', heardFinalText: true }
  }
  const keptRef: RefObject<DictationKeptRecording | null> = { current: null }
  const ownerRef: { current: ReturnType<typeof useDictationQueuedSend> | null } = { current: null }
  const rootRef: RefObject<HTMLDivElement | null> = { current: null }
  const props = { onSend: vi.fn(), sessionRef, keptRef, ownerRef, rootRef }
  const view = render(<Chat autoSendTo="session-a" {...props} />)
  const root = props.rootRef.current!
  props.keptRef.current = {
    chunks: [],
    complete: true,
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
  props.ownerRef.current!.follow(props.sessionRef.current)
  void props.ownerRef.current!.release(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(props.ownerRef.current!.autoSend).not.toBeNull()

  view.rerender(<Chat autoSendTo="session-b" {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })

  expect(props.ownerRef.current!.autoSend).toBeNull()
  expect(props.onSend).not.toHaveBeenCalled()
})
