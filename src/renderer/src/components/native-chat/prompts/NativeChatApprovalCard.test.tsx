// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'

afterEach(cleanup)

const LONG_COMMAND = Array.from({ length: 8 }, (_, i) => `echo line ${i + 1}`).join('\n')
const approval = {
  title: 'Allow Bash?',
  detail: LONG_COMMAND,
  options: [
    { label: 'Allow', send: 'allow' },
    { label: 'Deny', send: 'deny' }
  ]
}

describe('NativeChatApprovalCard', () => {
  it('opens a long command from the answer row and still cancels on Escape', () => {
    const onCancel = vi.fn()
    const { container } = render(
      <NativeChatApprovalCard approval={approval} onChoose={() => {}} onCancel={onCancel} />
    )
    const details = screen.getByRole('button', { expanded: false })
    expect(container.querySelector('[data-native-chat-approval-actions]')).toContainElement(details)
    fireEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(container.querySelector('[data-native-chat-approval-card]')!, {
      key: 'Escape'
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
