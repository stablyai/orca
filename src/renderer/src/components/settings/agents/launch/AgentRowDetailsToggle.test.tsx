// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentRowDetailsToggle } from './AgentRowDetailsToggle'

afterEach(cleanup)

it("names each row's chevron after its agent, so a list of them stays distinguishable", () => {
  const { rerender } = render(
    <>
      <AgentRowDetailsToggle open={false} panelId="a" agentLabel="Alpha" onToggle={() => {}} />
      <AgentRowDetailsToggle open panelId="b" agentLabel="Beta" onToggle={() => {}} />
    </>
  )
  const alpha = screen.getByRole('button', { name: 'Show Alpha details' })
  expect(screen.getByRole('button', { name: 'Hide Beta details' })).toBeTruthy()
  // The name alone carries the agent; a description repeating it would be read twice.
  expect(alpha.hasAttribute('aria-describedby')).toBe(false)

  rerender(
    <>
      <AgentRowDetailsToggle open panelId="a" agentLabel="Alpha" onToggle={() => {}} />
      <AgentRowDetailsToggle open panelId="b" agentLabel="Beta" onToggle={() => {}} />
    </>
  )
  expect(screen.getByRole('button', { name: 'Hide Alpha details' })).toBe(alpha)
})
