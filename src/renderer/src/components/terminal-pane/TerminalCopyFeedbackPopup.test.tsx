// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { act, cleanup, render } from '@testing-library/react'
import { TerminalCopyFeedbackPopup } from './TerminalCopyFeedbackPopup'
import {
  TERMINAL_COPY_FLASH_VISIBLE_MS,
  isTerminalCopyFlashVisible,
  notifyTerminalCopyFlash,
  pruneTerminalCopyFlashPaneIds
} from './terminal-copy-flash-store'

function makeTerminal(green?: string): Pick<Terminal, 'options'> {
  return { options: { theme: green ? { green } : {} } }
}

function renderPopup(paneId: number, green?: string): HTMLElement {
  const { container } = render(
    <TerminalCopyFeedbackPopup paneId={paneId} terminal={makeTerminal(green)} />
  )
  return container
}

describe('TerminalCopyFeedbackPopup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pruneTerminalCopyFlashPaneIds(new Set())
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('renders nothing until a copy flash fires', () => {
    const container = renderPopup(1, '#a9b665')
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('shows the herdr-style box anchored bottom-center while visible', () => {
    const container = renderPopup(1, '#a9b665')

    act(() => {
      notifyTerminalCopyFlash(1)
    })

    const overlay = container.querySelector('[aria-hidden="true"]')
    expect(overlay).toHaveClass('pointer-events-none', 'bottom-3', 'justify-center')
    const box = overlay!.firstElementChild!
    expect(box).toHaveTextContent('copied to clipboard')
    expect(box).toHaveStyle({ borderColor: '#a9b665' })
    expect(box.querySelector('span')).toHaveStyle({ color: '#a9b665' })
  })

  it('falls back to the status-success token when the theme has no green', () => {
    const container = renderPopup(1)

    act(() => {
      notifyTerminalCopyFlash(1)
    })

    // jest-dom cannot resolve custom properties in happy-dom; assert the inline value.
    const box = container.querySelector('[aria-hidden="true"]')!.firstElementChild as HTMLElement
    expect(box.style.borderColor).toBe('var(--color-status-success)')
  })

  it('unmounts when the visible window elapses', () => {
    const container = renderPopup(1, '#a9b665')
    act(() => {
      notifyTerminalCopyFlash(1)
    })
    expect(isTerminalCopyFlashVisible(1)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)
    })

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
