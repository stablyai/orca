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
it('keeps the terminal launch shown but waiting while the host connects, with chat usable and setup stable', async () => {
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    defaultSurface: 'terminal',
    surfaces: ['chat', 'terminal'],
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models: [] },
    rows: [{ kind: 'cli', agent: 'codex', chat: true }]
  }
  // Chat is not offered over this SSH host, so the row's own reason would be "No chat over SSH".
  const sshOnly: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    label: 'Claude',
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    rows: [{ kind: 'chat-unavailable', agent: 'claude', reason: 'ssh' }]
  }
  const launch = vi.fn()
  const menu = (terminalPending: boolean) => (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu
            entries={[entry, sshOnly]}
            runLaunch={launch}
            terminalPending={terminalPending}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const view = render(menu(true))
  const row = screen.getByRole('menuitem', { name: /Codex/ })
  // The row's launch waits and says why, without disabling Configure inside it.
  expect(row.getAttribute('aria-disabled')).toBeNull()
  const reason = document.getElementById(row.getAttribute('aria-describedby') ?? '')
  expect(reason?.textContent).toBe('Connecting…')
  const configure = screen.getByRole('button', { name: 'Configure Codex' })
  expect(configure.closest('[aria-disabled="true"], [disabled]')).toBeNull()
  fireEvent.click(row)
  expect(launch).not.toHaveBeenCalled()
  // One reason per row: the wait, not also the missing chat.
  const reasons = () =>
    [...screen.getByRole('menuitem', { name: /Claude/ }).querySelectorAll('.text-xs')].map(
      (node) => node.textContent
    )
  expect(reasons()).toEqual(['Connecting…'])
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Configure Codex' }))
  const buttons = () =>
    screen.getAllByRole('button', { name: /^Launch / }).map((button) => ({
      name: button.textContent,
      disabled: button.hasAttribute('disabled')
    }))
  // The terminal default stays the default and stays mounted; only its launch waits.
  expect(buttons()).toEqual([
    { name: 'Launch chat', disabled: false },
    { name: 'Launch terminal', disabled: true }
  ])
  const args = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')
  fireEvent.change(args()!, { target: { value: '--search' } })
  view.rerender(menu(false))
  expect(reasons()).toEqual(['No chat over SSH'])
  expect(args()?.value).toBe('--search')
  expect(buttons()).toEqual([
    { name: 'Launch chat', disabled: false },
    { name: 'Launch terminal', disabled: false }
  ])
  // A reconnect waits again; the explicit chat still starts.
  view.rerender(menu(true))
  expect(buttons()[1]).toEqual({ name: 'Launch terminal', disabled: true })
  await user.click(screen.getByRole('button', { name: 'Launch chat' }))
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: 'chat', agent: 'codex' }),
    expect.objectContaining({ surface: 'chat' }),
    expect.anything()
  )
})
