// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDictationConversationTarget } from '../dictation/dictation-conversation-target'
import { DICTATION_CONTROL_EVENT } from '../dictation/dictation-control-events'
import { useNativeChatVoiceInput } from './use-native-chat-voice-input'

const { store } = vi.hoisted(() => ({
  store: {
    dictationState: 'idle',
    settings: {
      uiLanguage: 'ko' as const,
      voice: { enabled: true, sttModel: 'zipformer-streaming-korean' }
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: typeof store) => unknown) => select(store), {
    getState: () => store
  })
}))

afterEach(() => {
  document.body.replaceChildren()
  store.dictationState = 'idle'
  store.settings.voice.sttModel = 'zipformer-streaming-korean'
})

function setup(onTranscript?: (text: string, final: boolean) => void) {
  const onReady = vi.fn()
  const beforeStart = vi.fn()
  const hook = renderHook(
    ({ active }) =>
      useNativeChatVoiceInput({
        active,
        autoSend: true,
        onReady,
        onBeforeStart: beforeStart,
        onTranscript
      }),
    { initialProps: { active: false } }
  )
  const element = document.createElement('textarea')
  document.body.appendChild(element)
  hook.result.current.inputRef.current = element
  hook.rerender({ active: true })
  const target = getDictationConversationTarget(element)
  if (!target) {
    throw new Error('No registered voice target')
  }
  const control = (event: Event) => {
    if (event instanceof CustomEvent) {
      store.dictationState = event.detail?.action === 'start' ? 'listening' : 'stopping'
    }
  }
  document.addEventListener(DICTATION_CONTROL_EVENT, control)
  return {
    ...hook,
    onReady,
    beforeStart,
    target,
    unmount: () => {
      hook.unmount()
      document.removeEventListener(DICTATION_CONTROL_EVENT, control)
    }
  }
}

describe('voice capture ownership', () => {
  it('streams partials and successive commits without closing or restarting capture', () => {
    const onTranscript = vi.fn()
    const { result, target, onReady, unmount } = setup(onTranscript)
    act(() => {
      result.current.start()
    })
    act(() => target.onPartial('첫 중간 자막'))
    expect(result.current.partial).toBe('첫 중간 자막')
    act(() => {
      target.onFinal('첫 문장')
      target.onPartial('다음 중간 자막')
      target.onFinal('다음 문장')
    })
    expect(onTranscript.mock.calls).toEqual([
      ['첫 중간 자막', false],
      ['첫 문장', true],
      ['다음 중간 자막', false],
      ['다음 문장', true]
    ])
    expect(store.dictationState).toBe('listening')
    expect(onReady).not.toHaveBeenCalled()
    expect(result.current.owned).toBe(true)
    act(() => {
      result.current.cancel()
      target.onFinal('늦은 결과')
    })
    expect(onTranscript).toHaveBeenCalledTimes(4)
    unmount()
  })
  it('starts in the sidebar without moving focus away from the terminal', () => {
    const { result, unmount } = setup()
    const terminal = document.createElement('textarea')
    document.body.appendChild(terminal)
    terminal.focus()
    act(() => {
      expect(result.current.start()).toBe(true)
    })
    expect(document.activeElement).toBe(terminal)
    unmount()
  })
  it('shows partial text and waits for the stopped fence before sending final text', () => {
    const { result, target, onReady, beforeStart, unmount } = setup()
    act(() => {
      result.current.start()
    })
    expect(beforeStart).toHaveBeenCalledTimes(1)
    act(() => target.onPartial('인식 중'))
    expect(result.current.partial).toBe('인식 중')
    act(() => target.onFinal('확정 문장'))
    expect(result.current.draft).toBe('확정 문장')
    expect(onReady).not.toHaveBeenCalled()
    act(() => {
      store.dictationState = 'idle'
      target.onStopped()
    })
    expect(onReady).toHaveBeenCalledExactlyOnceWith('확정 문장')
    unmount()
  })

  it('keeps text without sending when paused and rejects late results after a tab change', () => {
    const { result, target, onReady, rerender, unmount } = setup()
    act(() => {
      result.current.start()
      result.current.cancel()
    })
    act(() => {
      target.onFinal('보관할 내용')
      store.dictationState = 'idle'
      target.onStopped()
    })
    expect(result.current.draft).toBe('보관할 내용')
    expect(onReady).not.toHaveBeenCalled()
    act(() => {
      result.current.start()
    })
    rerender({ active: false })
    act(() => {
      target.onFinal('늦은 내용')
      target.onStopped()
    })
    expect(onReady).not.toHaveBeenCalled()
    expect(result.current.draft).toBe('보관할 내용')
    unmount()
  })

  it('refuses paid models and another active capture', () => {
    store.settings.voice.sttModel = 'openai'
    const first = setup()
    act(() => {
      expect(first.result.current.start()).toBe(false)
    })
    expect(first.beforeStart).not.toHaveBeenCalled()
    first.unmount()
    store.settings.voice.sttModel = 'zipformer-streaming-korean'
    store.dictationState = 'listening'
    const second = setup()
    act(() => {
      expect(second.result.current.start()).toBe(false)
    })
    expect(second.beforeStart).not.toHaveBeenCalled()
    second.unmount()
  })
})
