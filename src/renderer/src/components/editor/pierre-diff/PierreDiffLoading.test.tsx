// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PierreDiffLoading } from './PierreDiffLoading'

afterEach(cleanup)

it('keeps a live-surface error banner out of document flow', () => {
  const { container: overlay } = render(
    <PierreDiffLoading error="worker died" onRetry={() => {}} overlay />
  )
  const { container: inFlow } = render(<PierreDiffLoading error="worker died" onRetry={() => {}} />)
  const overlayBanner = overlay.querySelector('[role="alert"]')
  const inFlowBanner = inFlow.querySelector('[role="alert"]')
  expect(overlayBanner?.className).toMatch(/absolute/)
  expect(overlayBanner?.className).not.toMatch(/min-h-16/)
  expect(inFlowBanner?.className).not.toMatch(/absolute/)
  expect(inFlowBanner?.className).toMatch(/min-h-16/)
})

it('announces a loading line as status, not an alert', () => {
  const { container } = render(<PierreDiffLoading error={null} onRetry={() => {}} />)
  expect(container.querySelector('[role="status"]')).not.toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
