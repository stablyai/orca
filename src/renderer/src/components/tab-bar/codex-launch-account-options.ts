import type { ProviderAccountRef } from '../../../../shared/provider-account-ref'
import type { CodexManagedAccountSummary } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type CodexLaunchAccountLane = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

export type CodexLaunchAccountOption = {
  key: string
  label: string
  description: string
  providerAccountRef?: ProviderAccountRef
}

function sameLane(account: CodexManagedAccountSummary, lane: CodexLaunchAccountLane): boolean {
  const accountRuntime = account.managedHomeRuntime ?? 'host'
  if (accountRuntime !== lane.runtime) {
    return false
  }
  if (accountRuntime === 'host') {
    return true
  }
  return (
    account.wslDistro?.trim().toLocaleLowerCase('en-US') ===
    lane.wslDistro?.trim().toLocaleLowerCase('en-US')
  )
}

export function buildCodexLaunchAccountOptions(
  accounts: readonly CodexManagedAccountSummary[],
  lane: CodexLaunchAccountLane
): CodexLaunchAccountOption[] {
  const laneLabel = lane.runtime === 'wsl' ? `WSL ${lane.wslDistro ?? ''}`.trim() : 'host'
  return [
    {
      key: 'current-default',
      label: translate(
        'auto.components.tab.bar.CodexLaunchAccountMenu.currentDefault',
        'Current default'
      ),
      description: translate(
        'auto.components.tab.bar.CodexLaunchAccountMenu.currentDefaultDescription',
        'Follow the account currently selected for this runtime'
      )
    },
    {
      key: 'system-default',
      label: translate(
        'auto.components.tab.bar.CodexLaunchAccountMenu.systemLogin',
        'System Codex login'
      ),
      description: laneLabel,
      providerAccountRef: {
        provider: 'codex',
        accountId: null,
        runtime: lane.runtime,
        ...(lane.wslDistro ? { wslDistro: lane.wslDistro } : {})
      }
    },
    ...accounts
      .filter((account) => sameLane(account, lane))
      .map((account) => {
        const label = account.workspaceLabel?.trim() || account.email
        return {
          key: account.id,
          label,
          description: `${label === account.email ? '' : `${account.email} · `}${account.id}`,
          providerAccountRef: {
            provider: 'codex',
            accountId: account.id,
            runtime: lane.runtime,
            ...(lane.wslDistro ? { wslDistro: lane.wslDistro } : {})
          }
        }
      })
  ]
}
