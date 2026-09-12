// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID,
  BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID
} from '@/lib/settings-navigation-types'

const mocks = vi.hoisted(() => ({
  executionHostId: 'local' as string
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mocks.executionHostId
}))

import { RemoteRuntimeEgressIndicator, SshEgressIndicator } from './browser-egress-indicator'

type SetState = Parameters<typeof useAppStore.setState>[0]

function renderIndicator(worktreeId: string): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <SshEgressIndicator worktreeId={worktreeId} />
    </TooltipProvider>
  )
}

describe('SshEgressIndicator', () => {
  let priorSettings: ReturnType<typeof useAppStore.getState>['settings']
  let priorLabels: ReturnType<typeof useAppStore.getState>['sshTargetLabels']
  beforeEach(() => {
    priorSettings = useAppStore.getState().settings
    priorLabels = useAppStore.getState().sshTargetLabels
    useAppStore.setState({
      sshTargetLabels: new Map([['target-a', 'openclaw']])
    } as SetState)
  })
  afterEach(() => {
    useAppStore.setState({ settings: priorSettings, sshTargetLabels: priorLabels } as SetState)
    cleanup()
  })

  it('keeps the plain globe for non-SSH workspaces', () => {
    mocks.executionHostId = 'local'
    renderIndicator('wt-1')
    expect(screen.queryByTestId('ssh-egress-indicator')).toBeNull()
  })

  it('shows the routed icon with the host in its label for SSH workspaces', () => {
    mocks.executionHostId = 'ssh:target-a'
    renderIndicator('wt-1')
    const icon = screen.getByTestId('ssh-egress-indicator')
    expect(icon.getAttribute('data-egress')).toBe('ssh')
    expect(icon.getAttribute('aria-label')).toContain('openclaw')
  })

  it('shows the this-device icon when the target opted out', () => {
    mocks.executionHostId = 'ssh:target-a'
    useAppStore.setState({
      settings: { ...priorSettings, browserSshWorkspaceRoutingDisabledTargetIds: ['target-a'] }
    } as SetState)
    renderIndicator('wt-1')
    const icon = screen.getByTestId('ssh-egress-indicator')
    expect(icon.getAttribute('data-egress')).toBe('local')
    expect(icon.getAttribute('aria-label')).toContain('from this device')
  })

  it('shows the styled tooltip on focus/hover', () => {
    mocks.executionHostId = 'ssh:target-a'
    renderIndicator('wt-1')
    fireEvent.focus(screen.getByTestId('ssh-egress-indicator'))
    expect(screen.getByRole('tooltip').textContent).toContain('openclaw')
  })

  it('expands an explanation on click whose settings link deep-links to the routing setting', () => {
    mocks.executionHostId = 'ssh:target-a'
    const openSettingsTarget = vi.fn()
    const openSettingsPage = vi.fn()
    const prior = {
      openSettingsTarget: useAppStore.getState().openSettingsTarget,
      openSettingsPage: useAppStore.getState().openSettingsPage
    }
    useAppStore.setState({ openSettingsTarget, openSettingsPage } as unknown as SetState)
    try {
      renderIndicator('wt-1')
      fireEvent.click(screen.getByTestId('ssh-egress-indicator'))
      const link = screen.getByTestId('ssh-egress-indicator-settings')
      fireEvent.click(link)
      expect(openSettingsTarget).toHaveBeenCalledWith({
        pane: 'browser',
        repoId: null,
        sectionId: BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID
      })
      expect(openSettingsPage).toHaveBeenCalledTimes(1)
    } finally {
      useAppStore.setState(prior as unknown as SetState)
    }
  })
})

describe('RemoteRuntimeEgressIndicator', () => {
  let priorEnvironments: ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
  beforeEach(() => {
    priorEnvironments = useAppStore.getState().runtimeEnvironments
    useAppStore.setState({
      runtimeEnvironments: [{ id: 'env-1', name: 'Cloud Box' }]
    } as unknown as SetState)
  })
  afterEach(() => {
    useAppStore.setState({ runtimeEnvironments: priorEnvironments } as unknown as SetState)
    cleanup()
  })

  function renderRemote(presentation: 'client-hosted' | 'streamed'): void {
    render(
      <TooltipProvider>
        <RemoteRuntimeEgressIndicator runtimeEnvironmentId="env-1" presentation={presentation} />
      </TooltipProvider>
    )
  }

  it('labels client-hosted pages as browsing through the environment', () => {
    renderRemote('client-hosted')
    const icon = screen.getByTestId('ssh-egress-indicator')
    expect(icon.getAttribute('data-egress')).toBe('remote')
    expect(icon.getAttribute('aria-label')).toBe('Browsing through Cloud Box')
  })

  it('labels streamed pages as browsing on the environment', () => {
    renderRemote('streamed')
    expect(screen.getByTestId('ssh-egress-indicator').getAttribute('aria-label')).toBe(
      'Browsing on Cloud Box'
    )
  })

  it('falls back to the environment id when no summary is known', () => {
    useAppStore.setState({ runtimeEnvironments: [] } as unknown as SetState)
    renderRemote('client-hosted')
    expect(screen.getByTestId('ssh-egress-indicator').getAttribute('aria-label')).toContain('env-1')
  })

  it('deep-links its settings button to the client-hosted browser setting', () => {
    const openSettingsTarget = vi.fn()
    const openSettingsPage = vi.fn()
    const prior = {
      openSettingsTarget: useAppStore.getState().openSettingsTarget,
      openSettingsPage: useAppStore.getState().openSettingsPage
    }
    useAppStore.setState({ openSettingsTarget, openSettingsPage } as unknown as SetState)
    try {
      renderRemote('client-hosted')
      fireEvent.click(screen.getByTestId('ssh-egress-indicator'))
      fireEvent.click(screen.getByTestId('ssh-egress-indicator-settings'))
      expect(openSettingsTarget).toHaveBeenCalledWith({
        pane: 'browser',
        repoId: null,
        sectionId: BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID
      })
      expect(openSettingsPage).toHaveBeenCalledTimes(1)
    } finally {
      useAppStore.setState(prior as unknown as SetState)
    }
  })
})
