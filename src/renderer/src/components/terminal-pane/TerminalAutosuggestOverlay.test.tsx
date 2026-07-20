// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { TerminalAutosuggestOverlay } from './TerminalAutosuggestOverlay'

function makeFakeTerminal() {
  const rect = { width: 800, height: 480, left: 0, top: 0 }
  const screenEl = { getBoundingClientRect: () => rect }
  return {
    cols: 80,
    rows: 24,
    element: { querySelector: () => screenEl }
  } as unknown as Terminal
}

describe('TerminalAutosuggestOverlay', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when suggestionRemainder is empty', () => {
    const { container } = render(
      <TerminalAutosuggestOverlay
        terminal={makeFakeTerminal()}
        row={0}
        cursorCol={2}
        suggestionRemainder=""
        foregroundColor="#ffffff"
      />
    )
    expect(container.textContent).toBe('')
  })

  it('renders the suggestion remainder as text when present', () => {
    const { getByText } = render(
      <TerminalAutosuggestOverlay
        terminal={makeFakeTerminal()}
        row={0}
        cursorCol={2}
        suggestionRemainder="tatus"
        foregroundColor="#ffffff"
      />
    )
    expect(getByText('tatus')).toBeTruthy()
  })
})
