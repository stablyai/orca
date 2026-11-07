import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import Settings from './Settings'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
const checkedAt = Date.UTC(2026, 10, 8, 6)
function quota(provider: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider,
    status: 'ok',
    error: null,
    updatedAt: checkedAt,
    planType: 'pro',
    session: {
      windowMinutes: 300,
      usedPercent,
      resetsAt: checkedAt + 3600000,
      resetDescription: null
    },
    weekly: {
      windowMinutes: 10080,
      usedPercent: usedPercent + 10,
      resetsAt: checkedAt + 86400000,
      resetDescription: null
    }
  }
}
const rateLimits = createEmptyRateLimitState({
  claude: quota('claude', 42),
  codex: quota('codex', 27)
})
async function setup() {
  const noop = async () => {}
  useAppStore.setState({
    settingsNavigationTarget: { pane: 'stats', repoId: null },
    runtimeEnvironmentCatalogHydrated: true,
    statsSummary: {
      totalAgentsSpawned: 504,
      totalAgentTimeMs: 806400000,
      totalPRsCreated: 37,
      firstEventAt: checkedAt - 86400000 * 30
    },
    rateLimits,
    fetchRateLimits: noop,
    refreshRateLimits: noop,
    fetchInactiveClaudeAccountUsage: noop,
    fetchInactiveCodexAccountUsage: noop,
    fetchSettings: noop,
    fetchKeybindings: noop,
    refreshModelStates: noop,
    fetchStatsSummary: noop,
    fetchClaudeUsage: noop,
    fetchCodexUsage: noop,
    fetchOpenCodeUsage: noop,
    fetchMuseUsage: noop
  })
  window.api.runtime.subscribe = async (request, onResponse) => {
    if (request.method === 'accounts.subscribe') {
      queueMicrotask(() =>
        onResponse({
          id: 'quotas',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: {
            type: 'snapshot',
            snapshot: {
              claude: { accounts: [], activeAccountId: null },
              codex: { accounts: [], activeAccountId: null },
              rateLimits
            }
          }
        })
      )
    }
    return { unsubscribe: () => {}, sendBinary: () => {} }
  }
}
export const statsAndUsage = defineFixture({
  width: 1280,
  setup,
  render: () => (
    <div className="flex h-[1000px] bg-background">
      <ConfirmationDialogContext value={async () => false}>
        <Settings />
      </ConfirmationDialogContext>
    </div>
  )
})
