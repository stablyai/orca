// S0 states (agent-accounts spec §5): settings/agent-accounts/OrcaCloudAccounts:<state>.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsLoad } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode,
  OrcaCloudAgentsStatus
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
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

function fixture(
  rows: Record<OrcaCloudAccountAgent, OrcaCloudAccountRow> | null,
  load: OrcaCloudAgentAccountsLoad = READY,
  extra: {
    confirmRemove?: OrcaCloudAccountAgent
    rowError?: { agent: OrcaCloudAccountAgent; error: OrcaCloudAgentsErrorCode }
  } = {}
) {
  return defineFixture({
    width: 760,
    render: () => (
      <div className="bg-background p-6">
        <OrcaCloudAccountsView
          load={load}
          rows={rows}
          actions={ACTIONS}
          now={NOW}
          initialConfirmRemove={extra.confirmRemove}
          initialRowError={extra.rowError}
        />
      </div>
    )
  })
}

// RS-5: a Claude credential is always labelled "Claude subscription" (the approved account can't be known).
const CLAUDE_ACTIVE: OrcaCloudAccountRow = {
  kind: 'active',
  label: 'Claude subscription',
  expiresAt: NOW + YEAR,
  expiring: false,
  source: 'sign-in',
  keyKind: null,
  covered: false
}
const CODEX_TEAM: OrcaCloudAccountRow = { kind: 'notSetUp', keyKind: 'team' }

export const notSetUp = fixture({
  claude: { kind: 'notSetUp', keyKind: null },
  codex: CODEX_TEAM
})

export const loading = fixture(null, { kind: 'loading' })

export const settingUpClaude = fixture({
  claude: {
    kind: 'setup',
    setup: { phase: 'browser', startedAt: NOW - 14_000, canReopen: true }
  },
  codex: CODEX_TEAM
})

export const preparingCodex = fixture({
  claude: CLAUDE_ACTIVE,
  codex: { kind: 'setup', setup: { phase: 'preparing', startedAt: NOW - 4_000 } }
})

export const settingUpCodexDevice = fixture({
  claude: CLAUDE_ACTIVE,
  codex: {
    kind: 'setup',
    setup: {
      phase: 'device',
      startedAt: NOW - 38_000,
      userCode: 'K7QD-9WFM',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: NOW + 14 * 60_000
    }
  }
})

export const pasteToken = fixture({
  claude: { kind: 'setup', setup: { phase: 'paste', reason: 'capture_failed' } },
  codex: CODEX_TEAM
})

export const pasteTokenNoCli = fixture({
  claude: { kind: 'setup', setup: { phase: 'paste', reason: 'no_cli' } },
  codex: CODEX_TEAM
})

export const saving = fixture({
  claude: { kind: 'setup', setup: { phase: 'saving' } },
  codex: CODEX_TEAM
})

export const teamKeyChoice = fixture({
  claude: { kind: 'choice', keyKind: 'team' },
  codex: CODEX_TEAM
})

export const active = fixture({
  claude: CLAUDE_ACTIVE,
  codex: {
    kind: 'active',
    label: 'a@acme.dev',
    expiresAt: null,
    expiring: false,
    source: 'key',
    keyKind: 'team',
    covered: true
  }
})

export const expiring = fixture({
  claude: { ...CLAUDE_ACTIVE, expiresAt: NOW + 12 * 24 * 60 * 60 * 1000, expiring: true },
  codex: CODEX_TEAM
})

export const expired = fixture({
  claude: { kind: 'expired', keyKind: 'team', covered: true },
  codex: { kind: 'expired', keyKind: null, covered: false }
})

export const removeConfirm = fixture({ claude: CLAUDE_ACTIVE, codex: CODEX_TEAM }, READY, {
  confirmRemove: 'claude'
})

/** RA-5: Remove… from an expired row's ⋯ confirms like the active row. */
export const expiredRemoveConfirm = fixture(
  { claude: { kind: 'expired', keyKind: null, covered: false }, codex: CODEX_TEAM },
  READY,
  { confirmRemove: 'claude' }
)

export const killSwitch = fixture({
  claude: CLAUDE_ACTIVE,
  codex: { kind: 'killSwitch' }
})

/** Flag off on this server: never offered, so nothing reads as paused. */
export const unavailable = fixture({
  claude: CLAUDE_ACTIVE,
  codex: { kind: 'unavailable' }
})

/** Neither provider offered: the section collapses to one muted line. */
export const allUnavailable = fixture({
  claude: { kind: 'unavailable' },
  codex: { kind: 'unavailable' }
})

export const setupFailed = fixture({
  claude: { kind: 'failed', error: 'denied' },
  codex: { kind: 'failed', error: 'code_expired' }
})

export const signedOutOfOrca = fixture(null, { kind: 'failed', error: 'signed_out' })

export const error = fixture({ claude: CLAUDE_ACTIVE, codex: CODEX_TEAM }, READY, {
  rowError: { agent: 'claude', error: 'unavailable' }
})

export const loadError = fixture(null, { kind: 'failed', error: 'unavailable' })
