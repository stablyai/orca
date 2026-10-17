import { useState } from 'react'
import { toast } from 'sonner'
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { SetAgentKeptResult } from '../../../../shared/agent-run-account'
import type { TabAgentAccount } from './tab-agent-accounts'
import { useTabAgentAccounts } from './use-tab-agent-accounts'

function keepLabel(account: TabAgentAccount, split: boolean): string {
  return split
    ? translate(
        'components.tab.bar.TabAgentAccountMenuItems.keepAgentOn',
        'Keep {{value0}} on {{value1}}',
        { value0: account.agentLabel, value1: account.accountLabel }
      )
    : translate('components.tab.bar.TabAgentAccountMenuItems.keepOn', 'Keep on {{value0}}', {
        value0: account.accountLabel
      })
}

function disabledReason(account: TabAgentAccount): string | null {
  if (account.keepDisabledReason === 'no-session') {
    return translate(
      'components.tab.bar.TabAgentAccountMenuItems.noSession',
      'Available once the agent reports its session'
    )
  }
  if (account.keepDisabledReason === 'codex-home-not-keepable') {
    return translate(
      'components.tab.bar.TabAgentAccountMenuItems.customCodexHome',
      'Not available while CODEX_HOME is set'
    )
  }
  return null
}

function failureMessage(reason: Extract<SetAgentKeptResult, { ok: false }>['reason']): string {
  if (reason === 'read-only') {
    return translate(
      'components.tab.bar.TabAgentAccountMenuItems.readOnly',
      'A newer version of Orca saved the list of kept agents, so this version cannot change it.'
    )
  }
  return reason === 'unavailable'
    ? translate(
        'components.tab.bar.TabAgentAccountMenuItems.unavailable',
        'Orca could not save this right now. Try again in a moment.'
      )
    : translate(
        'components.tab.bar.TabAgentAccountMenuItems.failed',
        'This agent cannot be kept on its account right now.'
      )
}

/** "Keep on <account>", one per agent pane whose host published its account. */
export function TabAgentAccountMenuItems({ tabId }: { tabId: string }): React.JSX.Element | null {
  const accounts = useTabAgentAccounts(tabId)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  if (accounts.length === 0) {
    return null
  }

  const setKept = (account: TabAgentAccount, kept: boolean): void => {
    // Why disable at once: a slow host round trip must not let a second click race the first.
    setPending((current) => new Set(current).add(account.paneKey))
    void window.api.agentAccounts
      .setKept({
        paneKey: account.paneKey,
        ...(account.ptyId ? { ptyId: account.ptyId } : {}),
        kept
      })
      .then((result) => {
        if (!result.ok) {
          toast.error(failureMessage(result.reason))
          return
        }
        const ptyId = account.ptyId
        if (kept && account.provider === 'codex' && ptyId) {
          // Why: a kept pane is answered; its "Restart on <new account>" would now restart on the kept one.
          useAppStore.getState().dismissCodexRestartNotices([ptyId])
        }
        // Why: a released Codex pane may already sit behind the selection, so it gets today's prompt.
        if (!kept && account.provider === 'codex' && ptyId) {
          // Why lazy: the restart scan's module graph is only needed after a release.
          void import('@/lib/codex-session-restart').then(
            ({ markRestoredStaleCodexSessionsForRestart }) =>
              markRestoredStaleCodexSessionsForRestart({ ptyIds: [ptyId] })
          )
        }
      })
      .catch(() => toast.error(failureMessage('unavailable')))
      .finally(() =>
        setPending((current) => {
          const next = new Set(current)
          next.delete(account.paneKey)
          return next
        })
      )
  }

  return (
    <>
      <DropdownMenuSeparator />
      {accounts.map((account) => {
        const reason = disabledReason(account)
        return (
          <DropdownMenuCheckboxItem
            key={account.paneKey}
            checked={account.kept}
            disabled={reason !== null || pending.has(account.paneKey)}
            onCheckedChange={(checked) => setKept(account, checked)}
            data-tab-agent-account-keep={account.paneKey}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{keepLabel(account, accounts.length > 1)}</span>
              {reason ? <span className="text-muted-foreground">{reason}</span> : null}
            </span>
          </DropdownMenuCheckboxItem>
        )
      })}
    </>
  )
}
