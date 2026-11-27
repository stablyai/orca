import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatToolRunDrawnRow } from '../../runs/use-native-chat-tool-run-window'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'
import type { WorkerDockIdentity } from './worker-dock-groups'

/** The open card's drawn rows, agents then background commands. With both listed, each set is its
 *  own named group and a quiet label (not a focus stop) sits above the first command row. */
export function WorkerDockGroupedRows({
  items,
  drawn,
  agentRows,
  grouped,
  small,
  measureRow,
  rows,
  mixed,
  visible,
  pending,
  onOpen,
  onAction
}: {
  items: readonly WorkerDockIdentity[]
  drawn: readonly NativeChatToolRunDrawnRow[]
  /** How many rows (first in `items`) are agents; the rest are background commands. */
  agentRows: number
  /** Both groups are listed: each is named, and the label sits above the first command row. */
  grouped: boolean
  small: boolean
  measureRow: (element: HTMLDivElement | null) => void
  rows: ReadonlyMap<string, WorkerDockRowView>
  mixed: boolean
  visible: boolean
  pending: ReadonlySet<string>
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
  const commandsLabel = t('components.native-chat.workerDock.commandsRegion', 'Background commands')
  const renderRow = (item: NativeChatToolRunDrawnRow) => {
    const identity = items[item.index]
    const row = rows.get(identity.id)
    return (
      <div
        key={identity.id}
        data-index={item.index}
        ref={small ? undefined : measureRow}
        style={{
          position: small ? 'relative' : 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: small ? undefined : `translateY(${item.start}px)`
        }}
      >
        {item.index === firstCommand ? (
          // Its group carries the name for assistive technology; the label itself is not a focus stop.
          <div
            aria-hidden="true"
            data-worker-dock-group-label=""
            className="mt-1 flex h-6 items-center border-t border-border pl-2 pt-1 text-xs text-muted-foreground"
          >
            <span className="min-w-0 truncate">{commandsLabel}</span>
          </div>
        ) : null}
        {/* One component either way, so focus on a loading row survives its details arriving. */}
        <WorkerDockRow
          id={identity.id}
          row={row}
          mixed={mixed}
          visible={visible}
          pending={row ? pending.has(row.id) : false}
          onOpen={onOpen}
          onAction={onAction}
        />
      </div>
    )
  }
  const firstCommand = grouped ? agentRows : -1
  const agents = drawn.filter((item) => item.index < agentRows)
  const commands = drawn.filter((item) => item.index >= agentRows)
  // Both wrappers are always drawn, so a row keeps its parent (and focus) when the other group
  // appears or leaves; each is a named group only while both groups are listed and it has rows.
  return (
    <>
      <div
        {...(grouped && agents.length
          ? {
              role: 'group',
              'aria-label': t('components.native-chat.workerDock.workersRegion', 'Workers')
            }
          : {})}
      >
        {agents.map(renderRow)}
      </div>
      <div {...(grouped && commands.length ? { role: 'group', 'aria-label': commandsLabel } : {})}>
        {commands.map(renderRow)}
      </div>
    </>
  )
}
