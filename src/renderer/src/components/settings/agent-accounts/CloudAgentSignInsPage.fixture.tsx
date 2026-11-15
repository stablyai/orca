// The move (Neil): Orca Cloud's sign-ins as their own page in the Orca Cloud group, and the one
// row Agent accounts keeps. settings/agent-accounts/CloudAgentSignInsPage:<state>.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudAgentAccountsLoad } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { OrcaCloudAgentsStatus } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { AgentAccountsJumpRow } from '../accounts/AgentAccountsJumpRow'
import { AgentAccountsSubsection } from '../accounts/AgentAccountsSubsection'
import { SettingsSection } from '../section-layout/SettingsSection'
import { CloudAgentSignInsLinkRow } from './CloudAgentSignInsLinkRow'
import { OrcaCloudAccountsDescription } from './OrcaCloudAccountsDescription'
import { OrcaCloudAccountsView, type OrcaCloudAccountsActions } from './OrcaCloudAccounts'

const NOW = Date.UTC(2026, 10, 10, 18, 0, 0)
const YEAR = 365 * 24 * 60 * 60 * 1000
const noop = (): void => {}
const ACTIONS: OrcaCloudAccountsActions = {
  start: noop,
  cancel: noop,
  reopen: noop,
  usePaste: noop,
  submitSetupCode: noop,
  pasteToken: async () => null,
  remove: async () => null,
  setSource: async () => null,
  copyCode: noop,
  retryLoad: noop,
  signIn: noop
}
const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'none' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
}
const READY: OrcaCloudAgentAccountsLoad = { kind: 'ready', status: STATUS }

/** Settings › Orca Cloud › Cloud agent sign-ins, as settings-orca-cloud-section-renderers draws it. */
export const cloudAgentSignIns = defineFixture({
  width: 860,
  render: () => (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id="cloud-agent-sign-ins"
        title="Cloud agent sign-ins"
        description={<OrcaCloudAccountsDescription />}
        forceVisible
        grouped
      >
        <OrcaCloudAccountsView
          load={READY}
          rows={{
            claude: {
              kind: 'active',
              label: 'Claude subscription',
              expiresAt: NOW + YEAR,
              expiring: false,
              source: 'sign-in',
              keyKind: null,
              covered: false
            },
            codex: { kind: 'notSetUp', keyKind: null }
          }}
          actions={ACTIONS}
          now={NOW}
          hideHeader
        />
      </SettingsSection>
    </div>
  )
})

/** Settings › Agent accounts in an Orca Cloud build: the link row above This computer. */
export const agentAccountsLinkRow = defineFixture({
  width: 860,
  render: () => (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id="accounts"
        title="Agent accounts"
        description="Sign-ins, account switching and usage for your agents."
        forceVisible
        grouped
      >
        <AgentAccountsJumpRow
          links={[
            { id: 'accounts-this-host', title: 'This computer' },
            { id: 'accounts-hosts', title: 'Hosts' }
          ]}
        />
        <CloudAgentSignInsLinkRow onOpen={noop} />
        <AgentAccountsSubsection
          id="accounts-this-host"
          title="This computer"
          description="Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them."
        >
          <div className="h-24 rounded-xl border border-dashed border-border/60" />
        </AgentAccountsSubsection>
      </SettingsSection>
    </div>
  )
})
