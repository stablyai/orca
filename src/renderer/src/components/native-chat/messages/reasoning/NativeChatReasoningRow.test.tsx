// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'

afterEach(cleanup)

const message = {
  id: 'reasoning-1',
  role: 'assistant',
  state: 'completed',
  timestamp: 1,
  completedAt: 2
} as const

it('starts open when reasoning is set to show expanded, and a click still collapses it', () => {
  const settings = useAppStore.getState().settings
  onTestFinished(() => useAppStore.setState({ settings }))
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatReasoningExpanded: true }
  })

  render(<NativeChatReasoningRow message={message} markdown="Checking the parser first." />)
  const trigger = screen.getByRole('button')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')

  fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
