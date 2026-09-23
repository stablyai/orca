// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatRuntimeStatus } from './NativeChatRuntimeStatus'

describe('NativeChatRuntimeStatus', () => {
  afterEach(cleanup)

  it('shows compacting and the current goal together in one non-modal strip', () => {
    render(
      <NativeChatRuntimeStatus
        compacting
        goal={{
          objective: 'Ship the parser without dropping queued sends',
          status: 'paused',
          updatedAt: Date.UTC(2026, 8, 21, 10, 30)
        }}
      />
    )

    expect(screen.getByRole('status').textContent).toContain('Compacting the conversation')
    expect(screen.getByText('Ship the parser without dropping queued sends')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(document.querySelector('[data-native-chat-runtime-status]')).toBeTruthy()
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('unmounts when neither runtime state exists', () => {
    const { container } = render(<NativeChatRuntimeStatus compacting={false} goal={null} />)
    expect(container.textContent).toBe('')
  })
})
