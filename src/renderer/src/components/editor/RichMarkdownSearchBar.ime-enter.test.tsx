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

function renderBar(spies: { onReplaceCurrent: () => void; onClose: () => void }): HTMLInputElement {
  act(() => {
    root.render(
      <RichMarkdownSearchBar
        activeMatchIndex={0}
        isOpen
        isReplaceMode
        matchCase={false}
        matchCount={2}
        query="배포"
        replaceQuery="릴리스"
        replaceDisabled={false}
        searchInputRef={createRef<HTMLInputElement>()}
        wholeWord={false}
        onClose={spies.onClose}
        onMoveToMatch={vi.fn()}
        onQueryChange={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceCurrent={spies.onReplaceCurrent}
        onReplaceQueryChange={vi.fn()}
        onToggleMatchCase={vi.fn()}
        onToggleReplaceMode={vi.fn()}
        onToggleWholeWord={vi.fn()}
      />
    )
  })
  // Why: the replace row is the second field; its input carries the replace value.
  const input = [...container.querySelectorAll('input')].find(
    (candidate) => candidate.value === '릴리스'
  )
  if (!input) {
    throw new Error('replace input not rendered')
  }
  return input
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

describe('RichMarkdownSearchBar replace-field IME guard', () => {
  it('does not replace on the Enter that commits a CJK composition', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderBar({ onReplaceCurrent, onClose: vi.fn() })

    pressKey(input, 'Enter', { isComposing: true })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  it('does not replace on an Enter reported as keyCode 229', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderBar({ onReplaceCurrent, onClose: vi.fn() })

    pressKey(input, 'Enter', { keyCode: 229 })

    expect(onReplaceCurrent).not.toHaveBeenCalled()
  })

  it('does not close the bar on the Escape that cancels a composition', () => {
    const onClose = vi.fn()
    const input = renderBar({ onReplaceCurrent: vi.fn(), onClose })

    pressKey(input, 'Escape', { isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('still replaces on a plain Enter', () => {
    const onReplaceCurrent = vi.fn()
    const input = renderBar({ onReplaceCurrent, onClose: vi.fn() })

    pressKey(input, 'Enter')

    expect(onReplaceCurrent).toHaveBeenCalledTimes(1)
  })

  it('still closes the bar on a plain Escape', () => {
    const onClose = vi.fn()
    const input = renderBar({ onReplaceCurrent: vi.fn(), onClose })

    pressKey(input, 'Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
