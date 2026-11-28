import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { renderCodexAccountRow } from './accounts-pane-codex-account-row'
import { renderCodexSystemDefaultButton } from './accounts-pane-codex-system-default'

const day = Date.UTC(2026, 10, 20)
const accounts: CodexRateLimitAccountsState['accounts'] = [
  {
    id: 'work',
    email: 'work@example.com',
    createdAt: day,
    updatedAt: day,
    lastAuthenticatedAt: day
  },
  {
    id: 'personal',
    email: 'personal@example.com',
    displayName: 'Personal',
    createdAt: day,
    updatedAt: day,
    lastAuthenticatedAt: day
  }
]

function model(signInStale: boolean): AccountsPaneSectionModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fixture model with only the fields the rows read.
  return {
    accountOwner: { kind: 'local' },
    accountRuntime: { runtime: 'host', wslDistro: null, label: 'macOS' },
    accountRuntimeSentenceLabel: 'macOS',
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false },
    activeCodexAccountId: 'work',
    codexAccountPlans: new Map(),
    codexAccounts: { accounts, activeAccountId: 'work' },
    codexAction: 'idle',
    codexRateLimits: signInStale
      ? {
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: day,
          status: 'error',
          error: 'Your access token could not be refreshed'
        }
      : null,
    codexRateLimitTarget: { runtime: 'host', wslDistro: null },
    isRemoteAccountScope: false,
    renamingAccountKeys: new Set<string>(),
    runCodexAccountAction: async () => {},
    setRemoveCodexTarget: () => {},
    setRenameTarget: () => {},
    systemCodexActive: false,
    systemCodexMissingSignIn: false,
    systemCodexNeedsSignIn: false,
    visibleCodexAccounts: accounts
  } as unknown as AccountsPaneSectionModel
}

function rows(signInStale: boolean): React.JSX.Element {
  const view = model(signInStale)
  return (
    <div className="bg-background p-6">
      <SettingsGroup title="Codex">
        <div data-settings-row="" className="space-y-2 py-3">
          {renderCodexSystemDefaultButton(view, translate)}
          {accounts.map((account) => renderCodexAccountRow(account, view))}
        </div>
      </SettingsGroup>
    </div>
  )
}

export const savedAccounts = defineFixture({ width: 720, render: () => rows(false) })

export const activeNeedsReauth = defineFixture({ width: 720, render: () => rows(true) })
