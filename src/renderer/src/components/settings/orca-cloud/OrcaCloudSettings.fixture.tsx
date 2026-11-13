import type { McpSyncStatus } from '../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PlanBillingView } from '../../billing/PlanBillingSection'
import { sampleTeam } from '../../billing/plan-billing-fixtures'
import { AgentApiKeysCloudDescription } from '../agent-api-keys/AgentApiKeysCloudDescription'
import { CloudSecretsPane } from '../cloud-secrets/CloudSecretsPane'
import { FIXTURE_NAMES, fixtureCloudSecretsApi } from '../cloud-secrets/cloud-secrets-fixture-data'
import { CloudMcpSyncPanel } from '../runtime-environments/cloud-mcp/CloudMcpSyncPanel'
import { SettingsSection } from '../section-layout/SettingsSection'
import { OrcaCloudMcpServersView, type OrcaCloudMcpWorkspace } from './OrcaCloudMcpServersPane'
import { OrcaCloudSignedOutNotice } from './OrcaCloudSettingsPanes'

const noop = (): void => {}
const BARE_BODY = 'rounded-none border-0 bg-transparent p-0 shadow-none'

/** The pane as Settings draws it: page title and description over the bare body. */
function Page({
  id,
  title,
  description,
  children,
  bare = true
}: {
  id: string
  title: string
  description: React.ReactNode
  children?: React.ReactNode
  bare?: boolean
}): React.JSX.Element {
  return (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id={id}
        title={title}
        description={description}
        forceVisible
        bodyClassName={bare ? BARE_BODY : undefined}
      >
        {children}
      </SettingsSection>
    </div>
  )
}

const MCP_STATUS: McpSyncStatus = {
  environmentId: 'env-1',
  autoSync: true,
  running: false,
  lastSyncedAt: Date.UTC(2026, 10, 9, 16, 42),
  error: null,
  rows: [
    {
      key: 'claude:linear',
      agent: 'claude',
      name: 'linear',
      source: 'claude-user',
      transport: 'http',
      target: 'https://mcp.linear.app',
      included: true,
      state: 'synced',
      outcome: 'added'
    },
    {
      key: 'claude:figma-desktop',
      agent: 'claude',
      name: 'figma-desktop',
      source: 'claude-user',
      transport: 'stdio',
      target: 'figma-mcp',
      included: true,
      state: 'skipped',
      skipReason: 'local-command'
    },
    {
      key: 'codex:memory',
      agent: 'codex',
      name: 'memory',
      source: 'codex',
      transport: 'stdio',
      target: 'npx',
      included: true,
      state: 'synced',
      outcome: 'added'
    }
  ]
}

const ONE: OrcaCloudMcpWorkspace[] = [
  { runtimeId: 'rt-1', name: 'acme/web · fix-login', environmentId: 'env-1' }
]
const TWO: OrcaCloudMcpWorkspace[] = [
  ...ONE,
  { runtimeId: 'rt-2', name: 'acme/api · billing-webhooks', environmentId: 'env-2' }
]

function mcpPage(workspaces: OrcaCloudMcpWorkspace[] | null | 'failed'): React.JSX.Element {
  return (
    <Page
      id="cloud-mcp"
      title="MCP servers"
      description="MCP servers from Claude and Codex on this computer, synced to your cloud workspaces."
    >
      <OrcaCloudMcpServersView
        workspaces={workspaces}
        onRetry={noop}
        renderSync={(workspace, onlyOne) => (
          <CloudMcpSyncPanel
            status={{ ...MCP_STATUS, environmentId: workspace.environmentId }}
            expanded={onlyOne}
            onToggleExpanded={noop}
            onSyncNow={noop}
            onToggleServer={noop}
            onToggleAutoSync={noop}
          />
        )}
      />
    </Page>
  )
}

export const mcpOneWorkspace = defineFixture({ width: 784, render: () => mcpPage(ONE) })
export const mcpTwoWorkspaces = defineFixture({ width: 784, render: () => mcpPage(TWO) })
export const mcpNoneRunning = defineFixture({ width: 784, render: () => mcpPage([]) })
export const mcpLoading = defineFixture({ width: 784, render: () => mcpPage(null) })
export const mcpLoadFailed = defineFixture({ width: 784, render: () => mcpPage('failed') })

export const secretsPage = defineFixture({
  width: 784,
  render: () => (
    <Page
      id="cloud-secrets"
      title="Cloud secrets"
      description="Orca swaps model API keys and agent sign-ins in at the network edge, so the sandbox never sees them. Other secrets reach cloud workspaces as environment variables that anything in the sandbox can read."
    >
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={[{ key: 'github.com/acme/web', label: 'acme/web' }]}
        people={{ nameFor: (userId: string) => FIXTURE_NAMES[userId] ?? null }}
        onSetUpAgent={noop}
      />
    </Page>
  )
})

export const billingPage = defineFixture({
  width: 784,
  render: () => (
    <Page
      id="cloud-billing"
      title="Plan & billing"
      description="Your Orca Cloud plan, sandbox hours and payment."
    >
      <PlanBillingView
        result={{ status: 'ok', entitlement: sampleTeam }}
        loading={false}
        busy={false}
        notice={null}
        onRefresh={noop}
        onPortal={noop}
        onSetOverage={noop}
        onSeePlans={noop}
      />
    </Page>
  )
})

const SIGNED_OUT: OrcaProfileAuthStatus = {
  activeProfileId: 'profile-1',
  configured: true,
  state: 'local',
  persistence: 'encrypted'
}

export const signedOut = defineFixture({
  width: 784,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => (
    <Page id="cloud-team" title="Team" description="Share one Orca Cloud plan with your teammates.">
      <OrcaCloudSignedOutNotice />
    </Page>
  )
})

export const sessionExpired = defineFixture({
  width: 784,
  store: { orcaProfileAuthStatus: { ...SIGNED_OUT, state: 'reconnect-required' } },
  render: () => (
    <Page
      id="cloud-secrets"
      title="Cloud secrets"
      description="Orca swaps model API keys and agent sign-ins in at the network edge, so the sandbox never sees them. Other secrets reach cloud workspaces as environment variables that anything in the sandbox can read."
    >
      <OrcaCloudSignedOutNotice />
    </Page>
  )
})

/** Settings › Agent API keys header: desktop keys are not for Orca Cloud; link to Cloud secrets. */
export const agentApiKeysHeader = defineFixture({
  width: 784,
  render: () => (
    <Page
      id="agent-api-keys"
      title="Agent API keys"
      description={<AgentApiKeysCloudDescription onOpenCloudSecrets={noop} />}
    />
  )
})
