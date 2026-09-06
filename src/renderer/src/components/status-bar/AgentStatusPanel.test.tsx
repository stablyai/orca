import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderReadiness } from './agent-readiness'
import type { AgentHealthSnapshot } from '../../../../shared/agent-health'
import type { AgentUpdateUiState } from './use-agent-health'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect: _onSelect,
    ...props
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => <div {...props}>{children}</div>
}))
vi.mock('./tooltip', () => ({ formatTimeAgo: () => 'just now' }))

import { AgentStatusPanel } from './AgentStatusPanel'

const providers: AgentProviderReadiness[] = [
  {
    provider: 'claude',
    installed: true,
    linkedAccountCount: 2,
    state: 'degraded',
    reason: 'network',
    activeAccount: {
      id: 'active',
      label: 'active@claude.test',
      active: true,
      state: 'degraded',
      reason: 'network',
      checkedAt: 1
    },
    accounts: [
      {
        id: null,
        label: 'System default',
        active: false,
        state: 'unknown',
        reason: 'not-checked',
        checkedAt: null
      },
      {
        id: 'active',
        label: 'active@claude.test',
        active: true,
        state: 'degraded',
        reason: 'network',
        checkedAt: 1
      },
      {
        id: 'inactive',
        label: 'inactive@claude.test',
        active: false,
        state: 'ready',
        reason: 'ready',
        checkedAt: 2
      }
    ]
  }
]

const healthSnapshots: AgentHealthSnapshot[] = [
  {
    provider: 'claude',
    cliStatus: 'available',
    health: 'healthy',
    version: '1.0.61',
    durationMs: 42,
    checkedAt: 3,
    checks: [{ id: 'cli', status: 'ok' }],
    latestVersion: null,
    updateAvailability: 'unknown',
    updateSupported: true
  }
]

function renderPanel(
  mode: 'verbose' | 'compact',
  updateStates: Partial<Record<'claude' | 'codex', AgentUpdateUiState>> = {}
): string {
  return renderToStaticMarkup(
    <AgentStatusPanel
      providers={providers}
      healthSnapshots={healthSnapshots}
      healthPendingProviders={{}}
      updateStates={updateStates}
      mode={mode}
      ownerLabel="This device"
      isRefreshing={false}
      loadError={false}
      onModeChange={() => {}}
      onRefresh={() => {}}
      onCheckAgent={() => {}}
      onUpdateAgent={() => {}}
      onManageAccounts={() => {}}
    />
  )
}

describe('AgentStatusPanel', () => {
  it('shows every account and diagnostic copy in detailed mode', () => {
    const markup = renderPanel('verbose')

    expect(markup).toContain('Connection status')
    expect(markup).toContain('Health')
    expect(markup).toContain('Available')
    expect(markup).toContain('v1.0.61')
    expect(markup).not.toContain('42 ms')
    expect(markup).toContain('Update status unavailable')
    expect(markup).toContain('Check')
    expect(markup).not.toContain('Check &amp; update')
    expect(markup).toContain('CLI: Passed')
    expect(markup).toContain('active@claude.test')
    expect(markup).toContain('inactive@claude.test')
    expect(markup).toContain('System default')
    expect(markup).toContain('Network check failed')
    expect(markup).toContain('Not checked')
  })

  it('keeps compact mode to the active account and provider summary', () => {
    const markup = renderPanel('compact')

    expect(markup).toContain('active@claude.test')
    expect(markup).not.toContain('inactive@claude.test')
    expect(markup).not.toContain('System default')
    expect(markup).not.toContain('Network check failed')
    expect(markup).not.toContain('CLI: Passed')
    expect(markup).toContain('Temporary issue')
  })

  it.each([
    [{ status: 'updating', version: null }, 'Updating…'],
    [{ status: 'failed', version: null }, 'Update failed']
  ] as const)('shows the %s update state', (updateState, expected) => {
    expect(renderPanel('verbose', { claude: updateState })).toContain(expected)
  })
})
