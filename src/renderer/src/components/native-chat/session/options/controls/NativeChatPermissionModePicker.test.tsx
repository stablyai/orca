// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPermissionModePicker } from './NativeChatPermissionModePicker'

afterEach(cleanup)

function renderPill(reported?: string): string | null {
  render(
    <TooltipProvider>
      <NativeChatPermissionModePicker
        current="own"
        reported={reported}
        modes={['ask', 'accept-edits', 'auto', 'full-access']}
        agent="claude"
        onSelect={() => {}}
      />
    </TooltipProvider>
  )
  return screen.getByRole('button').textContent
}

it('names the mode a chat following its agent settings runs in', () => {
  expect(renderPill('full-access')).toBe('Full access')
})

it('names the delegation until the agent reports a mode', () => {
  expect(renderPill()).toBe("Agents' own settings")
})
