import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../../store'

export function TerminalTabNeverHibernateMenuItem({
  tab
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
}): React.JSX.Element | null {
  // Read the flag from the store: the tab strip memoizes on layout, not on this field.
  const neverHibernate = useAppStore(
    (state) =>
      state.tabsByWorktree[tab.worktreeId]?.find((row) => row.id === tab.id)?.neverHibernate ===
      true
  )
  const hibernationEnabled = useAppStore(
    (state) => state.settings?.experimentalAgentHibernation === true
  )
  // Why: the flag is not mirrored to a remote host, so a remote tab would silently lose it.
  const isRemoteTab = useAppStore(
    (state) => getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId) !== null
  )
  const setTabNeverHibernate = useAppStore((state) => state.setTabNeverHibernate)
  // Stay reachable after hibernation is switched off so an existing opt-out can be cleared.
  if (isRemoteTab || !(hibernationEnabled || neverHibernate)) {
    return null
  }
  return (
    <DropdownMenuCheckboxItem
      checked={neverHibernate}
      onCheckedChange={(checked) => setTabNeverHibernate(tab.id, checked === true)}
    >
      {translate(
        'components.tab.bar.TerminalTabNeverHibernateMenuItem.neverHibernate',
        'Never Hibernate'
      )}
    </DropdownMenuCheckboxItem>
  )
}
