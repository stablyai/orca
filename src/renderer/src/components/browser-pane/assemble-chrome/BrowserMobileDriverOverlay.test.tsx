// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserMobileDriverOverlay } from './BrowserMobileDriverOverlay'

afterEach(() => {
  cleanup()
})

describe('BrowserMobileDriverOverlay', () => {
  it('renders Take back all alongside Take back when mobile drives a browser page', async () => {
    const onTakeBack = vi.fn()
    const onTakeBackAll = vi.fn()

    render(
      <BrowserMobileDriverOverlay
        driver={{ kind: 'mobile', clientId: 'phone-1' }}
        onTakeBack={onTakeBack}
        onTakeBackAll={onTakeBackAll}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take back all' }))
    })
    expect(onTakeBackAll).toHaveBeenCalledTimes(1)
    expect(onTakeBack).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take back' }))
    })
    expect(onTakeBack).toHaveBeenCalledTimes(1)
  })
})
