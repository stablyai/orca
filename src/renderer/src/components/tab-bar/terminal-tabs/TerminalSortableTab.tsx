import { useAppStore } from '@/store'
import { observeWorkerTabAgentIdentity } from '../../../../../shared/orchestration/workers/worker-tab-agent-identity'
import { resolveTerminalTabTitle } from '../../../../../shared/workspace-layout/tab-groups/tab-title-resolution'
import { useTabAgent } from '@/lib/agent-session/tab-identity/use-tab-agent'
import SortableTab from './SortableTab'
import type { SortableTabProps } from './sortable-tab-props'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'

type TerminalSortableTabProps = Omit<SortableTabProps, 'tab' | 'agent'> & { tab: TerminalTab }

/** A terminal pane can change agents, so its identity is inferred from live pane signals. */
export default function TerminalSortableTab(props: TerminalSortableTabProps): React.JSX.Element {
  const agent = useTabAgent(props.tab)
  const title = useAppStore((state) => {
    const stamp = props.tab.workerTab
    if (!stamp) {
      return props.tab.title
    }
    const leafId = stamp.current?.workerLeafId ?? stamp.origin.workerLeafId
    const entry = leafId ? state.agentStatusByPaneKey.get(`${props.tab.id}:${leafId}`) : undefined
    if (!entry || !observeWorkerTabAgentIdentity(stamp, entry)) {
      return props.tab.title
    }
    const tab = state.tabsByWorktree[props.tab.worktreeId]?.find((tab) => tab.id === props.tab.id)
    return tab
      ? resolveTerminalTabTitle(
          { ...tab, workerTab: undefined },
          state.settings?.tabAutoGenerateTitle === true
        )
      : props.tab.title
  })
  return <SortableTab {...props} tab={{ ...props.tab, title }} agent={agent} />
}
