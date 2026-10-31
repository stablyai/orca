import React from 'react'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StoreModule from '@/store'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'

const { shortcutLabelMock, useDetectedAgentsMock } = vi.hoisted(() => ({
  shortcutLabelMock: vi.fn<() => string | null>(),
  useDetectedAgentsMock: vi.fn((): { detectedIds: string[] | null; detectionFailed?: boolean } => ({
    detectedIds: ['claude', 'codex', 'gemini']
  }))
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: useDetectedAgentsMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: shortcutLabelMock
}))

vi.mock('@/store', async () => {
  const actual = await vi.importActual<typeof StoreModule>('@/store')
  const store = actual.useAppStore
  return {
    ...actual,
    useAppStore: Object.assign(
      <T>(selector: (state: ReturnType<typeof store.getState>) => T): T =>
        selector(store.getState()),
      store
    )
  }
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
      ReactActual.createElement('span', { 'data-dropdown-shortcut': 'true' }, children),
    DropdownMenuSeparator: () => ReactActual.createElement('hr')
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

const initial = useAppStore.getInitialState()
const settings = {
  ...getDefaultSettings('/tmp'),
  defaultTuiAgent: 'codex' as const,
  disabledTuiAgents: [],
  agentDefaultSurface: 'terminal' as const
}

beforeEach(() => {
  // A host without chats lists every agent as a terminal.
  setLocalRuntimeCapabilitiesForTests([])
  shortcutLabelMock.mockReset()
  shortcutLabelMock.mockReturnValue(null)
  useDetectedAgentsMock.mockClear()
  useAppStore.setState(
    {
      ...initial,
      settings,
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'worktree-1', repoId: TEST_REPO.id, hostId: 'local' })]
      },
      repos: [TEST_REPO]
    },
    true
  )
})

afterEach(() => {
  useAppStore.setState(initial, true)
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
    // Detect agents on the workspace’s execution host; client PATH cannot describe a paired runtime.
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'worktree-1', repoId: 'repo-1', hostId: 'runtime:env-1' })]
      },
      repos: [{ ...TEST_REPO, id: 'repo-1' }]
    })

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'runtime',
      environmentId: 'env-1',
      worktreeId: 'worktree-1'
    })
  })

  it('prefers the paired runtime owner over its server-side SSH connection', () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'worktree-1', repoId: 'repo-1' })]
      },
      repos: [
        {
          ...TEST_REPO,
          id: 'repo-1',
          connectionId: 'server-only-ssh-target',
          executionHostId: 'runtime:env-1'
        }
      ]
    })

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'runtime',
      environmentId: 'env-1',
      worktreeId: 'worktree-1'
    })
  })

  it('routes agent detection to the owning SSH host', () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'worktree-1', repoId: 'repo-1' })]
      },
      repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: 'ssh-target-1' }]
    })

    renderAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenLastCalledWith({
      kind: 'ssh',
      connectionId: 'ssh-target-1'
    })
  })

  // Why (#25523): a host that never answered is not a host with nothing installed.
  it('says the host is unreachable instead of reporting no agents', () => {
    useDetectedAgentsMock.mockReturnValueOnce({ detectedIds: null, detectionFailed: true })

    const html = renderAgentMenuItems()

    expect(html).toContain('list terminal agents for this workspace')
    expect(html).not.toContain('No agents detected')
  })

  it('does not label an auto-picked or blank default as configured', () => {
    shortcutLabelMock.mockReturnValue('⌘⌥T')

    useAppStore.setState({ settings: { ...settings, defaultTuiAgent: null } })
    expect(renderAgentMenuItems()).not.toContain('data-dropdown-shortcut="true"')

    useAppStore.setState({ settings: { ...settings, defaultTuiAgent: 'blank' } })
    expect(renderAgentMenuItems()).not.toContain('data-dropdown-shortcut="true"')
  })
})
