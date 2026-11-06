// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionLinkDeliveryReview } from './SessionLinkDeliveryReview'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)
it('requires an explicit recipient-chat check before the owner can skip an unknown delivery', () => {
  const resolve = vi.fn()
  render(<SessionLinkDeliveryReview disabled={false} onResolve={resolve} />)
  fireEvent.click(screen.getByText('Review unconfirmed delivery'))
  const action = screen.getByRole('button', { name: 'Mark reviewed; do not resend' })
  expect(action.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'I checked the recipient chat' }))
  expect(action.hasAttribute('disabled')).toBe(false)
  fireEvent.click(action)
  expect(resolve).toHaveBeenCalledOnce()
})
