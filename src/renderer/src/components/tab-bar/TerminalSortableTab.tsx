import { useTabAgent } from '@/lib/use-tab-agent'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import SortableTab, { type SortableTabProps } from './SortableTab'

type TerminalSortableTabProps = Omit<SortableTabProps, 'tab' | 'agent'> & { tab: TerminalTab }

/** A terminal pane can change agents, so its identity is inferred from live pane signals. */
export default function TerminalSortableTab(props: TerminalSortableTabProps): React.JSX.Element {
  const agent = useTabAgent(props.tab)
  return <SortableTab {...props} agent={agent} />
}
