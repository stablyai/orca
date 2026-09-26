import { useCallback, useRef, useState } from 'react'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { claudeTabAccountLabel } from '@/lib/claude-tab-account-label'
import { findLaunchRepo } from '@/lib/claude-launch-account'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { useAppStore } from '../../store'

/**
 * The pinned Claude account's email for a terminal tab's tooltip, or null when the tab shows
 * no label (unpinned, sentinel, unknown id, or an SSH repo). The account roster is fetched lazily
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
  const isSshRepo = useAppStore((s) =>
    Boolean(findLaunchRepo(s, { worktreeId: tab.worktreeId })?.connectionId)
  )
  const settings = useAppStore((s) => s.settings)

  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])
  const fetchedRef = useRef(false)

  const onTooltipOpenChange = useCallback(
    (open: boolean) => {
      if (!open || fetchedRef.current) {
        return
      }
      fetchedRef.current = true
      fetchProviderAccountsSnapshot(settings)
        .then((snapshot) => setAccounts(snapshot.claude.accounts))
        .catch(() => {
          fetchedRef.current = false
        })
    },
    [settings]
  )

  return {
    label: claudeTabAccountLabel({ statusAccountId, launchConfig }, accounts, { isSshRepo }),
    onTooltipOpenChange
  }
}
