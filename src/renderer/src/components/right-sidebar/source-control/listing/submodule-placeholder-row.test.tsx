// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubmodulePlaceholderRow } from './submodule-placeholder-row'

afterEach(cleanup)

describe('submodule error retry', () => {
  it('allows retrying the failed listing and disables the action while its retry is active', () => {
    const onRetry = vi.fn()
    const { getByRole, rerender } = render(
      <SubmodulePlaceholderRow depth={1} state="error" message="Offline" onRetry={onRetry} />
    )
    const button = getByRole('button')
    fireEvent.click(button)
    expect(onRetry).toHaveBeenCalledOnce()

    rerender(
      <SubmodulePlaceholderRow
        depth={1}
        state="error"
        message="Offline"
        onRetry={onRetry}
        refreshing
      />
    )
    const retryButton = getByRole('button')
    if (!(retryButton instanceof HTMLButtonElement)) {
      throw new Error('Expected a Retry button')
    }
    expect(retryButton.disabled).toBe(true)
    fireEvent.click(retryButton)
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
