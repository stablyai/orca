// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatEmptyState } from './host-access/NativeChatEmptyState'

afterEach(cleanup)

describe('NativeChatEmptyState', () => {
  it('introduces a persona in the agent’s place, only while the chat is empty', () => {
    const persona = {
      icon: <span data-testid="avatar" />,
      name: 'Scout',
      subtitle: 'Finds camp sites.'
    }
    const { rerender } = render(
      <NativeChatEmptyState kind="empty" agent="claude" persona={persona} />
    )
    expect(screen.getByText('Start a chat with Scout')).toBeTruthy()
    expect(screen.getByText('Finds camp sites.')).toBeTruthy()
    expect(screen.getByTestId('avatar')).toBeTruthy()

    rerender(<NativeChatEmptyState kind="loading" persona={persona} />)
    expect(screen.queryByTestId('avatar')).toBeNull()
  })
})
