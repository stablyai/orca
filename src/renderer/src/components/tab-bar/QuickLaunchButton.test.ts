import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickLaunchAgentMenuItems, shouldShowLaunchWatchdogTimeout } from './QuickLaunchButton'

const {
  shortcutLabelMock,
  storeState,
  openSettingsPageMock,
  openSettingsTargetMock,
  useDetectedAgentsMock
} = vi.hoisted(() => ({
  shortcutLabelMock: vi.fn<() => string | null>(),
  storeState: {
    settings: {
      defaultTuiAgent: 'codex' as 'claude' | 'codex' | 'gemini' | 'blank' | null,
      disabledTuiAgents: [] as string[]
    },
    worktreesByRepo: {} as Record<string, unknown[]>,
    repos: [] as unknown[],
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  },
  openSettingsPageMock: vi.fn(),
  openSettingsTargetMock: vi.fn(),
  useDetectedAgentsMock: vi.fn(() => ({ detectedIds: ['claude', 'codex', 'gemini'] }))
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: useDetectedAgentsMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: shortcutLabelMock
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => {
      return selector(storeState)
    },
    {
      getState: () => storeState
    }
  )

  return { useAppStore }
})

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = (await vi.importActual('react')) as {
    createElement: typeof React.createElement
  }

  return {
    getAgentCatalog: () => [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'gemini', label: 'Gemini' }
    ],
    AgentIcon: ({ agent }: { agent: string }) => ReactActual.createElement('span', null, agent)
  }
})

vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactActual = (await vi.importActual('react')) as {
    createElement: typeof React.createElement
  }

  return {
    DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode }) =>
      ReactActual.createElement('div', props, children),
    DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement('span', { 'data-dropdown-shortcut': 'true' }, children)
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: vi.fn()
}))

function renderAgentMenuItems(): string {
  return renderToStaticMarkup(
    React.createElement(QuickLaunchAgentMenuItems, {
      worktreeId: 'worktree-1',
      groupId: 'group-1',
      onFocusTerminal: vi.fn()
    })
  )
}

function rowMarkup(html: string, label: string): string {
  const start = html.indexOf(`title="Launch ${label} in a new terminal"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = html.indexOf('</div>', start)
  expect(end).toBeGreaterThan(start)

  return html.slice(start, end)
}

beforeEach(() => {
  shortcutLabelMock.mockReset()
  shortcutLabelMock.mockReturnValue(null)
  useDetectedAgentsMock.mockClear()
  openSettingsPageMock.mockReset()
  openSettingsTargetMock.mockReset()
  storeState.settings.defaultTuiAgent = 'codex'
  storeState.settings.disabledTuiAgents = []
  storeState.worktreesByRepo = {}
  storeState.repos = []
  storeState.openSettingsPage = openSettingsPageMock
  storeState.openSettingsTarget = openSettingsTargetMock
})

describe('QuickLaunchAgentMenuItems', () => {
  it('renders the new-agent shortcut next to the configured default agent only', () => {
    shortcutLabelMock.mockReturnValue('⌘⌥T')

    const html = renderAgentMenuItems()

    expect(html.match(/data-dropdown-shortcut="true"/g) ?? []).toHaveLength(1)
    expect(rowMarkup(html, 'Codex')).toContain('⌘⌥T')
    expect(rowMarkup(html, 'Claude')).not.toContain('⌘⌥T')
    expect(rowMarkup(html, 'Gemini')).not.toContain('⌘⌥T')
  })

  it('hides the default-agent shortcut when the action is unbound', () => {
    shortcutLabelMock.mockReturnValue(null)

    const html = renderAgentMenuItems()

    expect(html).not.toContain('data-dropdown-shortcut="true"')
  })

  it('routes agent detection to the worktree-owning runtime host, not the local client', () => {
    // Repro for the "Remote Server lists local agents" bug: a worktree owned by
    // a paired runtime must probe that runtime, never the client's PATH.
    storeState.worktreesByRepo = {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', hostId: 'runtime:env-1' }]
    }
    storeState.repos = [{ id: 'repo-1' }]

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })

  it('prefers the paired runtime owner over its server-side SSH connection', () => {
    storeState.worktreesByRepo = {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1' }]
    }
    storeState.repos = [
      {
        id: 'repo-1',
        connectionId: 'server-only-ssh-target',
        executionHostId: 'runtime:env-1'
      }
    ]

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })

  it('routes agent detection to the owning SSH host', () => {
    storeState.worktreesByRepo = {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1' }]
    }
    storeState.repos = [{ id: 'repo-1', connectionId: 'ssh-target-1' }]

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'ssh',
      connectionId: 'ssh-target-1'
    })
  })

  it('does not label an auto-picked or blank default as configured', () => {
    shortcutLabelMock.mockReturnValue('⌘⌥T')

    storeState.settings.defaultTuiAgent = null
    expect(renderAgentMenuItems()).not.toContain('data-dropdown-shortcut="true"')

    storeState.settings.defaultTuiAgent = 'blank'
    expect(renderAgentMenuItems()).not.toContain('data-dropdown-shortcut="true"')
  })
})

describe('shouldShowLaunchWatchdogTimeout', () => {
  it('does not report slow agent readiness once a PTY exists', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: true
      })
    ).toBe(false)
  })

  it('reports launches where no PTY appeared', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: false
      })
    ).toBe(true)
  })
})
