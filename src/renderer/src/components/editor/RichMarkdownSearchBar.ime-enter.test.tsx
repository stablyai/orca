// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'

function dispatchKey(el: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => el.dispatchEvent(event))
}

function renderReplaceInput(onReplaceCurrent: () => void): HTMLInputElement {
  const searchInputRef = React.createRef<HTMLInputElement>()
  const view = render(
    <RichMarkdownSearchBar
      activeMatchIndex={0}
      isOpen
      isReplaceMode
      matchCase={false}
      matchCount={3}
      query="a"
      replaceQuery=""
      replaceDisabled={false}
      searchInputRef={searchInputRef}
      wholeWord={false}
      onClose={vi.fn()}
      onMoveToMatch={vi.fn()}
      onQueryChange={vi.fn()}
      onReplaceAll={vi.fn()}
      onReplaceCurrent={onReplaceCurrent}
      onReplaceQueryChange={vi.fn()}
      onToggleMatchCase={vi.fn()}
      onToggleReplaceMode={vi.fn()}
      onToggleWholeWord={vi.fn()}
    />
  )
  return view.getByLabelText('Replace in rich markdown editor') as HTMLInputElement
}

afterEach(cleanup)

describe('RichMarkdownSearchBar IME Enter ownership', () => {
  it('does not replace on the marked confirm keydown', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderReplaceInput(onReplaceCurrent)

    fireEvent.compositionStart(input)
    dispatchKey(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  // Why: replace is not idempotent, so the unmarked Enter the Korean IME redispatches
  // after compositionEnd must not slip through and mutate the document.
  it('does not replace on the recorded Korean Enter redispatch', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderReplaceInput(onReplaceCurrent)

    fireEvent.compositionStart(input)
    dispatchKey(input, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input, { data: '가' })
    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })
    dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
    dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  it('replaces exactly once on ordinary Enter', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderReplaceInput(onReplaceCurrent)

    dispatchKey(input, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onReplaceCurrent).toHaveBeenCalledOnce()
  })
})
