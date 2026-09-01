// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GlobalSettings, TerminalQuickCommand } from '../../../../shared/types'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

const saveTerminalQuickCommand = vi.fn()
const deleteTerminalQuickCommand = vi.fn()
vi.mock('@/lib/agent-catalog-authoring', () => ({
  saveTerminalQuickCommand: (command: TerminalQuickCommand) => saveTerminalQuickCommand(command),
  deleteTerminalQuickCommand: (id: string) => deleteTerminalQuickCommand(id)
}))

// The real dialog has its own suite; this stub just replays the save the pane
// wires to the quick-command reference mutation.
vi.mock('@/components/terminal-quick-commands/TerminalQuickCommandDialog', () => ({
  createTerminalQuickCommandDraft: (scope: TerminalQuickCommand['scope']) => ({
    id: 'qc-draft',
    label: 'Start dev server',
    action: 'terminal-command',
    command: 'npm run dev',
    appendEnter: true,
    scope
  }),
  TerminalQuickCommandDialog: ({
    command,
    onSave
  }: {
    command: TerminalQuickCommand
    onSave: (next: TerminalQuickCommand) => void
  }) => (
    <button type="button" onClick={() => onSave(command)}>
      stub-save
    </button>
  )
}))

const { QuickCommandsPane } = await import('./QuickCommandsPane')

const settings = { terminalQuickCommands: [] } as unknown as GlobalSettings
const alwaysConfirm = async (): Promise<boolean> => true

function renderPane(): void {
  render(
    <ConfirmationDialogContext.Provider value={alwaysConfirm}>
      <QuickCommandsPane settings={settings} addCommandIntentSignal={1} />
    </ConfirmationDialogContext.Provider>
  )
}

describe('QuickCommandsPane durable-write failures', () => {
  beforeEach(() => {
    saveTerminalQuickCommand.mockReset()
    deleteTerminalQuickCommand.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it('tells the user nothing was saved when the reference write fails', async () => {
    saveTerminalQuickCommand.mockResolvedValue({
      ok: false,
      code: 'agent_reference_write_failed'
    })
    renderPane()

    fireEvent.click(screen.getByText('stub-save'))

    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain("Your change wasn't saved")
  })

  it('stays quiet when the quick command reached disk', async () => {
    saveTerminalQuickCommand.mockResolvedValue({ ok: true })
    renderPane()

    fireEvent.click(screen.getByText('stub-save'))
    await Promise.resolve()

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
