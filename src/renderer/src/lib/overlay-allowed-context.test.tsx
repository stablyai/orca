// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  const gated = useGatedOverlayOpen(open)
  return <span data-testid="gated">{String(gated.open)}</span>
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

function ToggleAllowed({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [allowed, setAllowed] = useState(true)
  return (
    <div>
      <button type="button" onClick={() => setAllowed(false)}>
        hide
      </button>
      <button type="button" onClick={() => setAllowed(true)}>
        show
      </button>
      <OverlayAllowedContext.Provider value={allowed}>{children}</OverlayAllowedContext.Provider>
    </div>
  )
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

  it('keeps uncontrolled overlays closed by default when allowed', () => {
    render(<Probe />)

    expect(screen.getByTestId('gated')).toHaveTextContent('false')
  })

  it('restores a controlled overlay when the subtree allows it again', () => {
    function Toggle(): React.JSX.Element {
      const [allowed, setAllowed] = useState(true)
      return (
        <div>
          <button type="button" onClick={() => setAllowed(false)}>
            hide
          </button>
          <button type="button" onClick={() => setAllowed(true)}>
            show
          </button>
          <OverlayAllowedContext.Provider value={allowed}>
            <Probe open />
          </OverlayAllowedContext.Provider>
        </div>
      )
    }

    render(<Toggle />)
    expect(screen.getByTestId('gated')).toHaveTextContent('true')
    fireEvent.click(screen.getByRole('button', { name: 'hide' }))
    expect(screen.getByTestId('gated')).toHaveTextContent('false')
    fireEvent.click(screen.getByRole('button', { name: 'show' }))
    expect(screen.getByTestId('gated')).toHaveTextContent('true')
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

  it('does not reopen a DropdownMenu that was open when the view was hidden', () => {
    render(
      <ToggleAllowed>
        <UncontrolledDropdownMenu />
      </ToggleAllowed>
    )

    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'hide', hidden: true }))
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'show' }))
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
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

  it('does not reopen a Select that was open when the view was hidden', () => {
    render(
      <ToggleAllowed>
        <UncontrolledSelect />
      </ToggleAllowed>
    )

    expect(document.body.querySelector('[data-slot="select-content"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'hide', hidden: true }))
    expect(document.body.querySelector('[data-slot="select-content"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'show' }))
    expect(document.body.querySelector('[data-slot="select-content"]')).toBeNull()
  })
})
