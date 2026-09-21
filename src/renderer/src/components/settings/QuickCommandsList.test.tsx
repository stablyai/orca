// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'
import type {
  TerminalCommandQuickCommand,
  TerminalQuickCommand
} from '../../../../shared/terminal-quick-command-types'
import { QuickCommandsList } from './QuickCommandsList'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return {
    ...actual,
    translate: (_key: string, fallback: string, values?: Record<string, string>) =>
      values
        ? Object.entries(values).reduce(
            (text, [token, value]) => text.replace(`{{${token}}}`, value),
            fallback
          )
        : fallback
  }
})

afterEach(cleanup)

function makeCommand(overrides: Partial<TerminalCommandQuickCommand> = {}): TerminalQuickCommand {
  return {
    id: 'build',
    label: 'Build',
    action: 'terminal-command',
    command: 'pnpm build',
    appendEnter: true,
    scope: { type: 'global' },
    ...overrides
  }
}

function renderList(
  commands: TerminalQuickCommand[],
  visibleCommands: TerminalQuickCommand[] = commands,
  hasQuery = false,
  onEdit = vi.fn(),
  onRemove = vi.fn()
) {
  return render(
    <QuickCommandsList
      commands={commands}
      visibleCommands={visibleCommands}
      hasQuery={hasQuery}
      repoById={new Map()}
      onEdit={onEdit}
      onRemove={onRemove}
    />
  )
}

describe('QuickCommandsList', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  it('keeps row actions reachable and gives each action its own semantics', async () => {
    const build = makeCommand()
    const empty = makeCommand({ id: 'empty', label: 'Empty', command: '   ', appendEnter: false })
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    renderList([build, empty], [build, empty], false, onEdit, onRemove)

    const edit = screen.getByRole('button', { name: 'Edit Build' })
    const copy = screen.getByRole('button', { name: 'Copy Build' })
    const remove = screen.getByRole('button', { name: 'Remove Build' })
    const emptyCopy = screen.getByRole('button', { name: 'Nothing to copy' })

    for (const button of [edit, copy, remove]) {
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    expect(emptyCopy).toBeDisabled()

    fireEvent.click(screen.getByText('Build', { exact: true }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(edit)
    expect(onEdit).toHaveBeenCalledWith(build)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith(build)

    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith('pnpm build')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('distinguishes empty, filtered, and unmatched states', () => {
    const command = makeCommand()
    const view = renderList([], [], false)
    expect(screen.getByText('No quick commands saved.')).toBeDefined()

    view.rerender(
      <QuickCommandsList
        commands={[command]}
        visibleCommands={[]}
        hasQuery={false}
        repoById={new Map()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('No commands in the selected scopes.')).toBeDefined()

    view.rerender(
      <QuickCommandsList
        commands={[command]}
        visibleCommands={[]}
        hasQuery={true}
        repoById={new Map()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('No commands match this search.')).toBeDefined()

    view.rerender(
      <QuickCommandsList
        commands={[command]}
        visibleCommands={[command]}
        hasQuery={false}
        repoById={new Map()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('Build', { exact: true })).toBeDefined()
    expect(screen.queryByText('No commands in the selected scopes.')).toBeNull()
  })
})
