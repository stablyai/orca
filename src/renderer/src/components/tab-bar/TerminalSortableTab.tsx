import { useTabAgent } from '@/lib/use-tab-agent'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import SortableTab, { type SortableTabProps } from './SortableTab'
import { useAppStore } from '../../store'
import { resolveTerminalDetachTarget } from '../../store/terminals/terminal-detachment'
import { useShallow } from 'zustand/react/shallow'

type TerminalSortableTabProps = Omit<SortableTabProps, 'tab' | 'agent'> & { tab: TerminalTab }

/** A terminal pane can change agents, so its identity is inferred from live pane signals. */
export default function TerminalSortableTab(props: TerminalSortableTabProps): React.JSX.Element {
  const agent = useTabAgent(props.tab)
  const detached = useAppStore((state) => props.tab.id in state.detachedTerminalByTabId)
  const target = useAppStore(
    useShallow((state) => resolveTerminalDetachTarget(state, props.tab.id))
  )
  const detachTerminalTab = useAppStore((state) => state.detachTerminalTab)
  const focusDetachedTerminalWindow = useAppStore((state) => state.focusDetachedTerminalWindow)
  return (
    <SortableTab
      {...props}
      agent={agent}
      canSplitTerminal={!detached}
      detachedWindow={{
        isDetached: detached,
        disabled: !target?.ptyId || target.remoteUnsupported || target.splitUnsupported,
        localOnly: target?.remoteUnsupported === true,
        onMove: () => {
          if (detached) {
            focusDetachedTerminalWindow(props.tab.id)
            return
          }
          void detachTerminalTab(props.tab.id)
        }
      }}
    />
  )
}
