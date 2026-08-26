/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstProjectTerminalWelcome } from './FirstProjectTerminalWelcome'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  detectedIds: ['claude'] as string[] | null,
  dismissFirstProjectTerminalWelcome: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  launchAgentInNewTab: vi.fn(() => ({ tabId: 'agent-tab' })),
  openModal: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  state: {
    settings: {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: []
    },
    unifiedTabsByWorktree: {
      'worktree-1': [
        {
          contentType: 'terminal',
          entityId: 'terminal-1',
          groupId: 'group-1'
        }
      ]
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        ...mocks.state,
        closeTab: mocks.closeTab,
        dismissFirstProjectTerminalWelcome: mocks.dismissFirstProjectTerminalWelcome,
        openModal: mocks.openModal,
        recordFeatureInteraction: mocks.recordFeatureInteraction
      }),
    {
      getState: () => ({
        ...mocks.state,
        closeTab: mocks.closeTab,
        dismissFirstProjectTerminalWelcome: mocks.dismissFirstProjectTerminalWelcome,
        openModal: mocks.openModal,
        recordFeatureInteraction: mocks.recordFeatureInteraction
      })
    }
  )
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => ({ id: 'repo-1', displayName: 'orca', path: '/repo' }),
  useWorktreeById: () => ({
    id: 'worktree-1',
    repoId: 'repo-1',
    branch: 'refs/heads/main',
    displayName: 'main'
  })
}))

vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: mocks.detectedIds,
    isLoading: false
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => 'Ctrl+N'
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude Code' }]
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: { value0?: string }) =>
    fallback.replace('{{value0}}', params?.value0 ?? '')
}))

function renderWelcome(
  colors = { background: '#f8f8f8', foreground: '#202020', accent: '#16823c' }
) {
  return render(
    <FirstProjectTerminalWelcome
      tabId="terminal-1"
      worktreeId="worktree-1"
      backgroundColor={colors.background}
      foregroundColor={colors.foreground}
      accentColor={colors.accent}
      fontFamily="Test Mono"
      fontSize={14}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.detectedIds = ['claude']
  mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'agent-tab' })
})

afterEach(() => {
  cleanup()
})

describe('FirstProjectTerminalWelcome', () => {
  it('uses the supplied terminal palette in both light and dark themes', () => {
    const view = renderWelcome()
    let dialog = screen.getByRole('dialog', { name: 'ORCA' })

    expect(dialog.style.backgroundColor).toBe('#f8f8f8')
    expect(dialog.style.color).toBe('#202020')
    expect(dialog.style.getPropertyValue('--orca-welcome-accent')).toBe('#16823c')
    expect(screen.getByText('Project opened: orca')).toBeTruthy()
    expect(screen.getByText('Branch: main')).toBeTruthy()

    view.rerender(
      <FirstProjectTerminalWelcome
        tabId="terminal-1"
        worktreeId="worktree-1"
        backgroundColor="#0b0f14"
        foregroundColor="#e6edf3"
        accentColor="#56d364"
        fontFamily="Test Mono"
        fontSize={14}
      />
    )
    dialog = screen.getByRole('dialog', { name: 'ORCA' })
    expect(dialog.style.backgroundColor).toBe('#0b0f14')
    expect(dialog.style.color).toBe('#e6edf3')
    expect(dialog.style.getPropertyValue('--orca-welcome-accent')).toBe('#56d364')
  })

  it('opens preselected workspace setup when the user presses 1', () => {
    renderWelcome()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'ORCA' }), { key: '1' })

    expect(mocks.dismissFirstProjectTerminalWelcome).toHaveBeenCalledWith('terminal-1')
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('workspace-creation')
    expect(mocks.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      initialRepoId: 'repo-1',
      telemetrySource: 'onboarding'
    })
  })

  it('dismisses to the normal shell on Enter', () => {
    renderWelcome()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'ORCA' }), { key: 'Enter' })

    expect(mocks.dismissFirstProjectTerminalWelcome).toHaveBeenCalledWith('terminal-1')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1')
  })

  it('replaces the blank shell with the detected default agent in the same group', () => {
    renderWelcome()

    fireEvent.click(screen.getByRole('button', { name: /Launch Claude Code in this checkout/i }))

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'worktree-1',
      groupId: 'group-1',
      launchSource: 'onboarding'
    })
    expect(mocks.closeTab).toHaveBeenCalledWith('terminal-1', {
      captureRecentlyClosed: false,
      reason: 'cleanup',
      recordInteraction: false
    })
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('agent-tab')
  })

  it('explains and disables direct launch when the default agent is unavailable', () => {
    mocks.detectedIds = []
    renderWelcome()

    expect(
      (
        screen.getByRole('button', {
          name: /Launch Claude Code in this checkout/i
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      screen.getByText('No default agent is available here. Choose one in workspace setup.')
    ).toBeTruthy()
  })
})
