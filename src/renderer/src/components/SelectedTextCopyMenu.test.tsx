// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectedTextCopyMenu } from './SelectedTextCopyMenu'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

beforeEach(() => {
  Object.assign(window, { api: { ui: { writeClipboardText: vi.fn() } } })
  setViewportSize(1200, 800)
})

function setViewportSize(width: number, height: number): void {
  Object.assign(window, { innerWidth: width, innerHeight: height })
}

function openMenuOnSelectedText(): void {
  render(
    <SelectedTextCopyMenu>
      <span data-testid="content">selected words</span>
    </SelectedTextCopyMenu>
  )
  const content = screen.getByTestId('content')
  const range = document.createRange()
  range.selectNodeContents(content)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  fireEvent.contextMenu(content, { clientX: 120, clientY: 240 })
}

describe('SelectedTextCopyMenu', () => {
  it('stays open when a resize reports the same viewport size', () => {
    openMenuOnSelectedText()

    // Why: the reveal reflow fires a real resize event without changing any dimension.
    fireEvent(window, new Event('resize'))

    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeNull()
  })

  it('still closes on a real resize that follows a no-op one', () => {
    openMenuOnSelectedText()

    fireEvent(window, new Event('resize'))
    setViewportSize(1200, 640)
    fireEvent(window, new Event('resize'))

    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })
})
