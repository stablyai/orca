// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)

const entries: AgentPickerEntry[] = (['codex', 'claude'] as const).map((agent) => ({
  agent: agent,
  label: agent === 'codex' ? 'Codex' : 'Claude',
  rows: [{ agent: agent, kind: 'chat' }],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'default', label: 'Default', isDefault: true, efforts: [] }]
  }
}))

function show(controlled = false) {
  const launched = vi.fn()
  const changed = vi.fn()
  function Menu() {
    const [open, setOpen] = useState(true)
    return (
      <TooltipProvider>
        <DropdownMenu
          open={controlled ? open : undefined}
          defaultOpen
          modal={false}
          onOpenChange={(next) => {
            changed(next)
            setOpen(next)
          }}
        >
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={entries} runLaunch={launched} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  }
  render(<Menu />)
  return { launched, changed }
}

it('moves one agent per Up/Down press, including after returning from its submenu', async () => {
  const { launched } = show()
  const user = userEvent.setup()
  const codex = screen.getByRole('menuitem', { name: /^Codex/ })
  const claude = screen.getByRole('menuitem', { name: /^Claude/ })
  codex.focus()
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(document.activeElement).toBe(claude))
  await user.keyboard('{ArrowUp}')
  await waitFor(() => expect(document.activeElement).toBe(codex))
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('menu', { name: 'Configure Codex' })).toBeTruthy()
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Configure Codex' }))
  )
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(document.activeElement).toBe(claude))
  expect(launched).not.toHaveBeenCalled()
})

it.each([false, true])(
  'closes a controlled=%s menu once after default launch',
  async (controlled) => {
    const { launched, changed } = show(controlled)
    await userEvent.setup().click(screen.getByRole('menuitem', { name: /^Codex/ }))
    expect(launched).toHaveBeenCalledExactlyOnceWith(entries[0].rows[0], undefined)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  }
)
