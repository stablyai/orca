import { useCallback, useRef, useState } from 'react'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { claudeTabAccountLabel } from '@/lib/claude-tab-account-label'
import { findLaunchRepo } from '@/lib/claude-launch-account'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { claudeAccountPinningUnsupportedReasonInState } from '@/components/settings/repository-claude-account'
import { useAppStore } from '../../store'

/**
 * The pinned Claude account's email for a terminal tab's tooltip, or null when the tab shows
 * no label (unpinned, sentinel, unknown id, or an SSH or WSL repo). The account roster is fetched lazily
 * on the first tooltip hover, not on every render, since the tab strip re-renders often.
 */
export function useClaudeTabAccountLabel(tab: TerminalTab): {
  label: string | null
  onTooltipOpenChange: (open: boolean) => void
} {
  const paneKey = useAppStore((s) => {
    const leafId = s.terminalLayoutsByTabId?.[tab.id]?.activeLeafId
    return leafId && isTerminalLeafId(leafId) ? makePaneKey(tab.id, leafId) : null
  })
  const statusAccountId = useAppStore((s) =>
    paneKey ? s.agentStatusByPaneKey?.[paneKey]?.claudeAccountId : undefined
  )
  const launchConfig = useAppStore((s) =>
    paneKey ? s.agentLaunchConfigByPaneKey?.[paneKey]?.launchConfig : undefined
  )
  const repo = useAppStore((s) => findLaunchRepo(s, { worktreeId: tab.worktreeId }))
  const settings = useAppStore((s) => s.settings)
  const pinningUnsupported = useAppStore((s) =>
    repo ? claudeAccountPinningUnsupportedReasonInState(s, repo) !== null : false
  )

  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])
  const fetchedRef = useRef(false)

  const onTooltipOpenChange = useCallback(
    (open: boolean) => {
      if (!open || fetchedRef.current) {
        return
      }
      fetchedRef.current = true
      fetchProviderAccountsSnapshot(getRepoOwnerRoutedSettings(settings, repo))
        .then((snapshot) => setAccounts(snapshot.claude.accounts))
        .catch(() => {
          fetchedRef.current = false
        })
    },
    [settings, repo]
  )

  return {
    label: claudeTabAccountLabel({ statusAccountId, launchConfig }, accounts, {
      pinningUnsupported
    }),
    onTooltipOpenChange
  }
}
