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
  expect(overlay.querySelector('[role="status"]')?.className).toMatch(/absolute/)
  expect(inFlow.querySelector('[role="status"]')?.className).not.toMatch(/absolute/)
})
