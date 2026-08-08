// @vitest-environment happy-dom

/** The composer grows with the draft up to 8 lines, then scrolls internally.
 *  Sizing is layout-driven (field-sizing + an lh-relative cap) rather than a JS
 *  measure pass, so these assert the class contract that produces it. happy-dom
 *  has no layout engine, so real pixel growth is covered by app validation. */

import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))

vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'

afterEach(() => cleanup())

function composerField(
  draft: string,
  callbacks: Partial<
    Pick<NativeChatComposerFieldProps, 'onDraftChange' | 'onKeyDown' | 'onCompositionEnd'>
  > = {}
): React.JSX.Element {
  return (
    <NativeChatComposerField
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft={draft}
      disabled={false}
      hasPty
      canSend
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notice={null}
      imageAttachments={[]}
      sendButtonDisabled={false}
      isWorking={false}
      attachDisabled={false}
      dictationDisabled={false}
      isDictating={false}
      isDictationHoldMode={false}
      onDraftChange={callbacks.onDraftChange ?? vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={callbacks.onKeyDown ?? vi.fn()}
      onCompositionStart={vi.fn()}
      onCompositionEnd={callbacks.onCompositionEnd ?? vi.fn()}
      onPaste={vi.fn()}
      pickerListboxId="picker"
      onChoosePickerItem={vi.fn()}
      onRetrySkills={vi.fn()}
      onAcceptMention={vi.fn()}
      onRemoveImageAttachment={vi.fn()}
      onAttach={vi.fn()}
      onDictationToggle={vi.fn()}
      onDictationHoldStart={vi.fn()}
      onDictationHoldEnd={vi.fn()}
      onSend={vi.fn()}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )
}

function renderField(draft: string): HTMLTextAreaElement {
  render(composerField(draft))
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('native chat composer autogrow', () => {
  it('sizes the textarea from its content instead of staying at rows={2}', () => {
    expect(renderField('').className).toContain('[field-sizing:content]')
  })

  it('caps growth at 8 lines plus the py-1 padding box', () => {
    // 8lh tracks the rendered line-height, so the cap follows the text tokens
    // instead of a hardcoded pixel value like the old max-h-28 (112px).
    const textarea = renderField('a\n'.repeat(20))
    expect(textarea.className).toContain('max-h-[calc(8lh+0.5rem)]')
    expect(textarea.className).not.toContain('max-h-28')
  })

  it('keeps the sleek scrollbar for the overflow past the cap', () => {
    expect(renderField('a\n'.repeat(20)).className).toContain('scrollbar-sleek')
  })

  it('keeps the touch-target minimum heights', () => {
    const textarea = renderField('')
    expect(textarea.className).toContain('min-h-12')
    expect(textarea.className).toContain('pointer-coarse:min-h-14')
  })

  it('does not pin an inline height that a resize could leave stale', () => {
    // A JS measure pass writes style.height and only re-measures on the next
    // value change, so a re-wrap from a window/pane resize would strand it.
    expect(renderField('a\n'.repeat(6)).style.height).toBe('')
  })
})

describe('native chat composer composition ownership', () => {
  it('preserves browser-owned Korean preedit through stale streaming rerenders', () => {
    const onCompositionEnd = vi.fn()
    const view = render(composerField('', { onCompositionEnd }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    textarea.value = '가'

    for (let index = 0; index < 120; index += 1) {
      view.rerender(composerField(`stale stream ${index}`, { onCompositionEnd }))
      expect(screen.getByRole('textbox')).toBe(textarea)
      expect(textarea.value).toBe('가')
    }

    fireEvent.compositionEnd(textarea, { data: '가' })
    expect(onCompositionEnd).toHaveBeenCalledOnce()
    expect(onCompositionEnd.mock.calls[0][0].target.value).toBe('가')
  })

  it('applies draft rerenders while ordinary English input is idle', () => {
    const view = render(composerField('abc'))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    view.rerender(composerField('ordinary'))

    expect(screen.getByRole('textbox')).toBe(textarea)
    expect(textarea.value).toBe('ordinary')
  })

  it('owns an unmarked Enter redispatch until the marked IME gesture keyup', () => {
    const onKeyDown = vi.fn()
    render(composerField('가', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)

    const markedResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: true
    })
    fireEvent.compositionEnd(textarea, { data: '가' })
    const redispatchResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(markedResult).toBe(true)
    expect(redispatchResult).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('retains the Windows Process gesture through its unmarked Enter redispatch', () => {
    const onKeyDown = vi.fn()
    render(composerField('가', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, {
      key: 'Process',
      keyCode: 229,
      isComposing: true
    })
    fireEvent.compositionEnd(textarea, { data: '가' })

    const redispatchResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatchResult).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    fireEvent.keyUp(textarea, { key: 'Process', keyCode: 229 })
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('retains an active composition when the Process event omits its composing flag', () => {
    const onKeyDown = vi.fn()
    render(composerField('가', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, {
      key: 'Process',
      keyCode: 229,
      isComposing: false
    })
    fireEvent.compositionEnd(textarea, { data: '가' })

    const redispatchResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatchResult).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('retains the macOS marked Enter/229 gesture through its unmarked redispatch', () => {
    const onKeyDown = vi.fn()
    let clearPending: FrameRequestCallback | undefined
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        clearPending = callback
        return 1
      })
    render(composerField('테스트', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(textarea, { data: '테스트' })
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })

    const redispatchResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatchResult).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    clearPending?.(0)
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(onKeyDown).toHaveBeenCalledOnce()
    animationFrame.mockRestore()
  })

  it('expires a marked Enter when the browser does not redispatch it', () => {
    const onKeyDown = vi.fn()
    let clearPending: FrameRequestCallback | undefined
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        clearPending = callback
        return 1
      })
    render(composerField('가', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(textarea, { data: '가' })
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })

    clearPending?.(0)
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onKeyDown).toHaveBeenCalledOnce()
    animationFrame.mockRestore()
  })

  it('does not let an older expiry clear a newer IME gesture', () => {
    const onKeyDown = vi.fn()
    const pendingFrames: FrameRequestCallback[] = []
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        pendingFrames.push(callback)
        return pendingFrames.length
      })
    render(composerField('가', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(textarea, { data: '가' })
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(textarea, { data: '나' })
    pendingFrames[0]?.(0)

    const redispatchResult = fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatchResult).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()
    animationFrame.mockRestore()
  })

  it('passes ordinary English Enter through without an IME gesture', () => {
    const onKeyDown = vi.fn()
    render(composerField('abc', { onKeyDown }))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
