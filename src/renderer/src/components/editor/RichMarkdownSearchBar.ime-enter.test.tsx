// @vitest-environment happy-dom

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null
}))

const QUERY = '배포'
const REPLACEMENT = '릴리스'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

type BarSpies = {
  onClose?: () => void
  onMoveToMatch?: (direction: 1 | -1) => void
  onReplaceCurrent?: () => void
}

function renderBar(spies: BarSpies): {
  findInput: HTMLInputElement
  replaceInput: HTMLInputElement
} {
  act(() => {
    root.render(
      <RichMarkdownSearchBar
        activeMatchIndex={0}
        isOpen
        isReplaceMode
        matchCase={false}
        matchCount={2}
        query={QUERY}
        replaceQuery={REPLACEMENT}
        replaceDisabled={false}
        searchInputRef={createRef<HTMLInputElement>()}
        wholeWord={false}
        onClose={spies.onClose ?? vi.fn()}
        onMoveToMatch={spies.onMoveToMatch ?? vi.fn()}
        onQueryChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={spies.onReplaceCurrent ?? vi.fn()}
        onReplaceQueryChange={vi.fn()}
        onToggleMatchCase={vi.fn()}
        onToggleReplaceMode={vi.fn()}
        onToggleWholeWord={vi.fn()}
      />
    )
  })
  const inputs = [...container.querySelectorAll('input')]
  // Why: match on value rather than order so a layout change fails loudly instead of
  // silently pointing the assertions at the wrong field.
  const findInput = inputs.find((candidate) => candidate.value === QUERY)
  const replaceInput = inputs.find((candidate) => candidate.value === REPLACEMENT)
  if (!findInput || !replaceInput) {
    throw new Error('search bar fields not rendered')
  }
  return { findInput, replaceInput }
}

function pressKey(
  input: HTMLInputElement,
  key: string,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

describe('RichMarkdownSearchBar replace field IME guard', () => {
  it('does not replace on the Enter that commits a CJK composition', () => {
    const onReplaceCurrent = vi.fn()
    const { replaceInput } = renderBar({ onReplaceCurrent })

    pressKey(replaceInput, 'Enter', { isComposing: true })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  it('does not replace on an Enter the IME reports as keyCode 229', () => {
    const onReplaceCurrent = vi.fn()
    const { replaceInput } = renderBar({ onReplaceCurrent })

    pressKey(replaceInput, 'Enter', { keyCode: 229 })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  it('does not close the bar on the Escape that cancels a composition', () => {
    const onClose = vi.fn()
    const { replaceInput } = renderBar({ onClose })

    pressKey(replaceInput, 'Escape', { isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still replaces on a plain Enter', () => {
    const onReplaceCurrent = vi.fn()
    const { replaceInput } = renderBar({ onReplaceCurrent })

    pressKey(replaceInput, 'Enter')

    expect(onReplaceCurrent).toHaveBeenCalledTimes(1)
  })

  it('still closes the bar on a plain Escape', () => {
    const onClose = vi.fn()
    const { replaceInput } = renderBar({ onClose })

    pressKey(replaceInput, 'Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('RichMarkdownSearchBar find field IME guard', () => {
  it('does not move to the next match on the Enter that commits a composition', () => {
    const onMoveToMatch = vi.fn()
    const { findInput } = renderBar({ onMoveToMatch })

    pressKey(findInput, 'Enter', { isComposing: true })

    expect(onMoveToMatch).not.toHaveBeenCalled()
  })

  it('does not move to the previous match on a composing Shift+Enter', () => {
    const onMoveToMatch = vi.fn()
    const { findInput } = renderBar({ onMoveToMatch })

    pressKey(findInput, 'Enter', { isComposing: true, shiftKey: true })

    expect(onMoveToMatch).not.toHaveBeenCalled()
  })

  it('does not move on an Enter the IME reports as keyCode 229', () => {
    const onMoveToMatch = vi.fn()
    const { findInput } = renderBar({ onMoveToMatch })

    pressKey(findInput, 'Enter', { keyCode: 229 })

    expect(onMoveToMatch).not.toHaveBeenCalled()
  })

  it('does not close the bar on the Escape that cancels a composition', () => {
    const onClose = vi.fn()
    const { findInput } = renderBar({ onClose })

    pressKey(findInput, 'Escape', { isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still moves to the next match on a plain Enter', () => {
    const onMoveToMatch = vi.fn()
    const { findInput } = renderBar({ onMoveToMatch })

    pressKey(findInput, 'Enter')

    expect(onMoveToMatch).toHaveBeenCalledWith(1)
  })

  it('still moves to the previous match on a plain Shift+Enter', () => {
    const onMoveToMatch = vi.fn()
    const { findInput } = renderBar({ onMoveToMatch })

    pressKey(findInput, 'Enter', { shiftKey: true })

    expect(onMoveToMatch).toHaveBeenCalledWith(-1)
  })

  it('still closes the bar on a plain Escape', () => {
    const onClose = vi.fn()
    const { findInput } = renderBar({ onClose })

    pressKey(findInput, 'Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
