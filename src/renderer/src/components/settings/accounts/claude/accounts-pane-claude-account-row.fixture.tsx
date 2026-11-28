import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { ClaudeRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { renderClaudeAccountRow } from './accounts-pane-claude-account-row'

const day = Date.UTC(2026, 10, 20)
const accounts: ClaudeRateLimitAccountsState['accounts'] = [
  {
    id: 'work',
    email: 'work@example.com',
    authMethod: 'subscription-oauth',
    organizationName: 'Example Inc',
    createdAt: day,
    updatedAt: day,
    lastAuthenticatedAt: day
  },
  {
    id: 'personal',
    email: 'personal@example.com',
    displayName: 'Personal',
    authMethod: 'subscription-oauth',
    createdAt: day,
    updatedAt: day,
    lastAuthenticatedAt: day
  },
  {
    id: 'old',
    email: 'old@example.com',
    authMethod: 'unknown',
    createdAt: day,
    updatedAt: day,
    lastAuthenticatedAt: day,
    needsSignIn: true
  }
]

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fixture model with only the fields the row reads.
const model = {
  accountOwner: { kind: 'local' },
  accountRuntime: { runtime: 'host', wslDistro: null, label: 'macOS' },
  accountRuntimeUnavailable: false,
  accountVisibilityOptions: { remoteOwner: false },
  claudeAccountPlans: new Map(),
  claudeAccounts: { accounts, activeAccountId: 'work' },
  claudeAction: 'idle',
  isRemoteAccountScope: false,
  renamingAccountKeys: new Set<string>(),
  runClaudeAccountAction: async () => {},
  setRemoveClaudeTarget: () => {},
  setRenameTarget: () => {}
} as unknown as AccountsPaneSectionModel

// Claude's saved account rows, the look other agents' account rows follow.
export const savedAccounts = defineFixture({
  width: 720,
  render: () => (
    <div className="bg-background p-6">
      <SettingsGroup title="Claude">
        <div data-settings-row="" className="space-y-2 py-3">
          {accounts.map((account) => renderClaudeAccountRow(account, model))}
        </div>
      </SettingsGroup>
    </div>
  )
})
