// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  getDictationConversationTarget,
  registerDictationConversationTarget
} from './dictation-conversation-target'
import { captureInsertionTarget, insertText } from './dictation-insertion-target'

describe('conversation dictation targets', () => {
  it('routes explicit sidebar capture independently of focus and never falls back after closure', () => {
    const terminal = document.createElement('textarea')
    const sidebar = document.createElement('textarea')
    document.body.append(terminal, sidebar)
    terminal.focus()
    const callbacks = { onPartial: vi.fn(), onFinal: vi.fn(), onStopped: vi.fn(), onError: vi.fn() }
    const unregister = registerDictationConversationTarget(sidebar, callbacks)
    const captured = captureInsertionTarget(sidebar)
    expect(captured?.kind).toBe('conversation')
    if (!captured) {
      throw new Error('Missing sidebar capture')
    }
    insertText('sidebar only', captured)
    expect(callbacks.onFinal).toHaveBeenCalledWith('sidebar only')
    expect(terminal.value).toBe('')
    expect(document.activeElement).toBe(terminal)
    unregister()
    expect(captureInsertionTarget(sidebar)).toBeNull()
    sidebar.remove()
    expect(captureInsertionTarget(sidebar)).toBeNull()
    terminal.remove()
  })
  it('keeps ordinary dictation available when the panel has not started capture', () => {
    const element = document.createElement('textarea')
    document.body.appendChild(element)
    element.focus()
    const unregister = registerDictationConversationTarget(element, {
      acceptsCapture: () => false,
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onStopped: vi.fn(),
      onError: vi.fn()
    })
    expect(captureInsertionTarget()?.kind).toBe('text')
    unregister()
    element.remove()
  })

  it('routes to the captured panel and ignores all late events after it closes', () => {
    const element = document.createElement('textarea')
    document.body.appendChild(element)
    element.focus()
    const callbacks = { onPartial: vi.fn(), onFinal: vi.fn(), onStopped: vi.fn(), onError: vi.fn() }
    const unregister = registerDictationConversationTarget(element, callbacks)
    const captured = captureInsertionTarget()
    expect(captured?.kind).toBe('conversation')
    if (!captured || captured.kind !== 'conversation') {
      throw new Error('Conversation target was not captured')
    }
    insertText('음성 요청', captured)
    expect(callbacks.onFinal).toHaveBeenCalledExactlyOnceWith('음성 요청')
    unregister()
    captured.target.onPartial('늦은 자막')
    captured.target.onFinal('늦은 요청')
    captured.target.onStopped()
    captured.target.onError('늦은 오류')
    expect(callbacks.onFinal).toHaveBeenCalledTimes(1)
    expect(callbacks.onPartial).not.toHaveBeenCalled()
    expect(callbacks.onStopped).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(getDictationConversationTarget(element)).toBeNull()
    element.remove()
  })
})
