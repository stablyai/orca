// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Slider } from './slider'

afterEach(cleanup)

function thumbs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="slider-thumb"]'))
}

describe('Slider', () => {
  it('renders one thumb for a single-value slider', () => {
    const { container } = render(<Slider value={[40]} min={0} max={100} aria-label="Volume" />)

    expect(thumbs(container)).toHaveLength(1)
    expect(container.querySelector('[data-slot="slider"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="slider-track"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="slider-range"]')).toBeInTheDocument()
  })

  it('renders one thumb when neither value nor defaultValue is supplied', () => {
    const { container } = render(<Slider min={0} max={100} aria-label="Volume" />)

    expect(thumbs(container)).toHaveLength(1)
  })

  it('renders two thumbs for a two-value range slider', () => {
    const { container } = render(<Slider value={[20, 80]} min={0} max={100} />)

    expect(thumbs(container)).toHaveLength(2)
  })

  it('renders two thumbs from an uncontrolled two-value defaultValue', () => {
    const { container } = render(<Slider defaultValue={[10, 60]} min={0} max={100} />)

    expect(thumbs(container)).toHaveLength(2)
  })

  it('exposes both range values on the thumbs', () => {
    render(<Slider value={[20, 80]} min={0} max={100} />)

    const handles = screen.getAllByRole('slider')

    expect(handles).toHaveLength(2)
    expect(handles.map((handle) => handle.getAttribute('aria-valuenow'))).toEqual(['20', '80'])
  })

  it('labels range thumbs and their display values', () => {
    render(
      <Slider
        value={[4, 14]}
        min={0}
        max={14}
        thumbLabels={['Quiet time minimum', 'Quiet time maximum']}
        thumbValueLabels={['30m', '∞']}
      />
    )

    expect(screen.getByRole('slider', { name: 'Quiet time minimum' })).toHaveAttribute(
      'aria-valuetext',
      '30m'
    )
    expect(screen.getByRole('slider', { name: 'Quiet time maximum' })).toHaveAttribute(
      'aria-valuetext',
      '∞'
    )
  })
})
