// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)
it('keeps Configure and the explicit chat choice usable while the preferred terminal is pending', async () => {
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    defaultSurface: 'terminal',
    surfaces: ['chat'],
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models: [] },
    rows: [{ kind: 'cli', agent: 'codex', chat: true, terminalUnavailable: 'Loading agents' }]
  }
  const launch = vi.fn()
  render(
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu entries={[entry]} runLaunch={launch} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const row = screen.getByRole('menuitem', { name: /Codex/ })
  expect(row.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(row)
  expect(launch).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Configure Codex' }))
  expect(document.body.textContent).toContain('Loading agents')
  expect(document.body.textContent).not.toContain('Launch terminal')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Launch chat' }))
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: 'chat', agent: 'codex' }),
    expect.objectContaining({ surface: 'chat' }),
    expect.anything()
  )
})
