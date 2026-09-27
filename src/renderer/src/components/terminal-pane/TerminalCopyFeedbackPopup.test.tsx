// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { act, cleanup, render } from '@testing-library/react'
import { TerminalCopyFeedbackPopup } from './TerminalCopyFeedbackPopup'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  TERMINAL_COPY_FLASH_VISIBLE_MS,
  isTerminalCopyFlashVisible,
  notifyTerminalCopyFlash,
  pruneTerminalCopyFlashLeafIds
} from './terminal-copy-flash-store'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

function makeTerminal(green?: string): Pick<Terminal, 'options'> {
  return { options: { theme: green ? { green } : {} } }
}

function renderPopup(leafId: TerminalLeafId, green?: string): HTMLElement {
  const { container } = render(
    <TerminalCopyFeedbackPopup leafId={leafId} terminal={makeTerminal(green)} />
  )
  return container
}

describe('TerminalCopyFeedbackPopup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pruneTerminalCopyFlashLeafIds(new Set([LEAF_ID]))
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('renders nothing until a copy flash fires', () => {
    const container = renderPopup(LEAF_ID, '#a9b665')
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('shows the herdr-style box anchored bottom-center while visible', () => {
    const container = renderPopup(LEAF_ID, '#a9b665')

    act(() => {
      notifyTerminalCopyFlash(LEAF_ID)
    })

    const overlay = container.querySelector('[aria-hidden="true"]')
    expect(overlay).toHaveClass('pointer-events-none', 'bottom-3', 'justify-center')
    const box = overlay!.firstElementChild!
    expect(box).toHaveTextContent('copied to clipboard')
    expect(box).toHaveStyle({ borderColor: '#a9b665' })
    expect(box.querySelector('span')).toHaveStyle({ color: '#a9b665' })
  })

  it('falls back to the status-success token when the theme has no green', () => {
    const container = renderPopup(LEAF_ID)

    act(() => {
      notifyTerminalCopyFlash(LEAF_ID)
    })

    // jest-dom cannot resolve custom properties in happy-dom; assert the inline value.
    const box = container.querySelector('[aria-hidden="true"]')!.firstElementChild as HTMLElement
    expect(box.style.borderColor).toBe('var(--color-status-success)')
  })

  it('unmounts when the visible window elapses', () => {
    const container = renderPopup(LEAF_ID, '#a9b665')
    act(() => {
      notifyTerminalCopyFlash(LEAF_ID)
    })
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)
    })

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
