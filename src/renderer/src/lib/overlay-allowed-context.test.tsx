// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { OverlayAllowedContext, useGatedOverlayOpen } from './overlay-allowed-context'

function Probe({ open }: { open?: boolean }): React.JSX.Element {
  const gatedOpen = useGatedOverlayOpen(open)
  return <span data-testid="gated">{gatedOpen === undefined ? 'unset' : String(gatedOpen)}</span>
}

function UncontrolledDropdownMenu(): React.JSX.Element {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Row actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit row</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UncontrolledSelect(): React.JSX.Element {
  return (
    <Select defaultOpen>
      <SelectTrigger>
        <SelectValue placeholder="Site" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="cloud">Cloud</SelectItem>
      </SelectContent>
    </Select>
  )
}

function Disallowed({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <OverlayAllowedContext.Provider value={false}>{children}</OverlayAllowedContext.Provider>
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

  it('force-closes uncontrolled overlays when the subtree disallows them', () => {
    render(
      <OverlayAllowedContext.Provider value={false}>
        <Probe />
      </OverlayAllowedContext.Provider>
    )

    expect(screen.getByTestId('gated')).toHaveTextContent('false')
  })

  it('leaves uncontrolled overlays unset when overlays are allowed', () => {
    render(<Probe />)

    expect(screen.getByTestId('gated')).toHaveTextContent('unset')
  })
})

describe('uncontrolled overlay portals', () => {
  it('does not leave DropdownMenu content in document.body when overlays are disallowed', () => {
    render(
      <Disallowed>
        <UncontrolledDropdownMenu />
      </Disallowed>
    )

    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
  })

  it('still portals DropdownMenu content when overlays are allowed', () => {
    render(<UncontrolledDropdownMenu />)

    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
  })

  it('does not leave Select content in document.body when overlays are disallowed', () => {
    render(
      <Disallowed>
        <UncontrolledSelect />
      </Disallowed>
    )

    expect(document.body.querySelector('[data-slot="select-content"]')).toBeNull()
  })

  it('still portals Select content when overlays are allowed', () => {
    render(<UncontrolledSelect />)

    expect(document.body.querySelector('[data-slot="select-content"]')).not.toBeNull()
  })
})
