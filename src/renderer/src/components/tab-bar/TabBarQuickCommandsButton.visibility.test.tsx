// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const appStoreMock = vi.hoisted(() => ({
  state: {
    settings: {
      showTerminalQuickCommandsButton: undefined as boolean | undefined,
      terminalQuickCommands: []
    },
    recentQuickCommandIdByGroup: {},
    repos: [{ id: 'repo-1' }],
    updateSettings: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof appStoreMock.state) => unknown) =>
    selector(appStoreMock.state)
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

vi.mock('@/components/terminal-quick-commands/TerminalQuickCommandDialog', () => ({
  createTerminalQuickCommandDraft: () => ({
    id: 'draft',
    label: '',
    action: 'terminal-command',
    command: '',
    appendEnter: true,
    scope: { type: 'repo', repoId: 'repo-1' }
  }),
  TerminalQuickCommandDialog: () => null
}))

vi.mock('./TabBarQuickCommandsMenu', () => ({
  TabBarQuickCommandsMenu: () => <div data-testid="quick-commands-menu" />
}))

vi.mock('@/hooks/use-terminal-quick-command-hosts', () => ({
  flattenTerminalQuickCommandHosts: () => [],
  useTerminalQuickCommandHosts: () => ({
    executionHostId: 'local',
    hosts: [{ commands: [], hostId: 'local', label: 'This computer' }],
    refreshRemoteHost: vi.fn(),
    remoteHostLoadFailed: false,
    remoteHostPending: false
  })
}))

vi.mock('@/lib/run-quick-command-in-new-tab', () => ({
  runQuickCommandInNewTab: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children
}))

vi.mock('lucide-react', () => ({
  Play: () => null
}))

describe('TabBarQuickCommandsButton visibility', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    appStoreMock.state.settings.showTerminalQuickCommandsButton = undefined
  })

  it('keeps the button visible when the setting is missing for legacy settings', async () => {
    const { TabBarQuickCommandsButton } = await import('./TabBarQuickCommandsButton')

    render(<TabBarQuickCommandsButton worktreeId="repo-1::/repo" groupId="group-1" />)

    expect(screen.getByRole('button', { name: 'Add quick command' })).toBeTruthy()
  })

  it('hides the button when the persisted setting is disabled', async () => {
    appStoreMock.state.settings.showTerminalQuickCommandsButton = false
    const { TabBarQuickCommandsButton } = await import('./TabBarQuickCommandsButton')

    const view = render(<TabBarQuickCommandsButton worktreeId="repo-1::/repo" groupId="group-1" />)

    expect(view.container.childElementCount).toBe(0)
  })
})
