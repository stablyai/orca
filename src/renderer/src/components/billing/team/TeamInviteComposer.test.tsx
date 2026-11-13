// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TeamInviteComposer } from './TeamInviteComposer'

afterEach(cleanup)

const RULE = 'Each invite uses a seat once accepted.'

it('says only the seat rule, with no seat counts or prices, however many are entered', () => {
  render(<TeamInviteComposer viewerRole="owner" onInvite={async () => ({ failed: [] })} />, {
    wrapper: TooltipProvider
  })
  const input = screen.getByRole('textbox')
  const hint = document.getElementById(input.getAttribute('aria-describedby')!)!
  expect(hint.textContent).toBe(RULE)

  fireEvent.change(input, { target: { value: 'jordan@acme.dev, kim@acme.dev ' } })
  expect(hint.textContent).toBe(RULE)
  expect(hint.textContent).not.toMatch(/open seat|\$|prorated/)
})

it('still flags invalid entries after the rule', () => {
  render(<TeamInviteComposer viewerRole="owner" onInvite={async () => ({ failed: [] })} />, {
    wrapper: TooltipProvider
  })
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'jordan@acme.dev, not-an-email ' } })
  const hint = document.getElementById(input.getAttribute('aria-describedby')!)!
  expect(hint.textContent).toBe(`${RULE} Skipping 1 invalid entry.`)
})
