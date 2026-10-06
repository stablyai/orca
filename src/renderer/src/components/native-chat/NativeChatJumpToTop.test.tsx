// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-app-root-test-render'
import { NativeChatJumpToTop } from './NativeChatJumpToTop'

afterEach(cleanup)

// The reader is usually mid-draft when they reach for this: a press must not take the caret.
it('leaves focus in the composer when pressed with the pointer', async () => {
  const startFromBeginning = vi.fn()
  render(
    <>
      <NativeChatJumpToTop visible historyJump={{ startPending: false, startFromBeginning }} />
      <textarea aria-label="Message" />
    </>
  )
  const composer = screen.getByRole('textbox', { name: 'Message' })
  composer.focus()

  await userEvent.click(screen.getByRole('button', { name: 'Jump to top' }))

  // Anti-vacuous: the press did act.
  expect(startFromBeginning).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(composer)
})

// Mounted while hidden so it can fade out; it must not stay reachable meanwhile.
it('stays mounted but unreachable while hidden', () => {
  const { container } = render(
    <NativeChatJumpToTop
      visible={false}
      historyJump={{ startPending: false, startFromBeginning: vi.fn() }}
    />
  )

  expect(screen.queryByRole('button', { name: 'Jump to top' })).toBeNull()
  const button = container.querySelector('button')
  expect(button).toHaveAttribute('inert')
  expect(button).toHaveAttribute('data-shown', 'false')
})
