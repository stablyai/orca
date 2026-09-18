// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { OverlayAllowedContext, useGatedOverlayOpen } from './overlay-allowed-context'

function Probe({ open }: { open?: boolean }): React.JSX.Element {
  const gatedOpen = useGatedOverlayOpen(open)
  return <span data-testid="gated">{gatedOpen === undefined ? 'unset' : String(gatedOpen)}</span>
}

afterEach(() => {
  cleanup()
})

describe('useGatedOverlayOpen', () => {
  it('defaults to allowing overlays', () => {
    render(<Probe open />)

    expect(screen.getByTestId('gated')).toHaveTextContent('true')
  })

  it('hides controlled overlays when the subtree disallows them', () => {
    render(
      <OverlayAllowedContext.Provider value={false}>
        <Probe open />
      </OverlayAllowedContext.Provider>
    )

    expect(screen.getByTestId('gated')).toHaveTextContent('false')
  })

  it('leaves uncontrolled overlays unset so Radix keeps its own open state', () => {
    render(
      <OverlayAllowedContext.Provider value={false}>
        <Probe />
      </OverlayAllowedContext.Provider>
    )

    expect(screen.getByTestId('gated')).toHaveTextContent('unset')
  })
})
