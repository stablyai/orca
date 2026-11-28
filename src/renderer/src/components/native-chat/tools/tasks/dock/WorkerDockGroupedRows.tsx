import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatToolRunDrawnRow } from '../../runs/use-native-chat-tool-run-window'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'
import type { WorkerDockIdentity } from './worker-dock-groups'

// Rows rise in 22ms apart once the open shape is ~20% grown; later rows share the last delay.
const rowDelay = (position: number) =>
  `calc(var(--worker-dock-morph-ms) * 0.2 + ${Math.min(position, 10) * 22}ms)`
// How long after the list starts opening a mounting row still counts as arriving with it: past the
// virtual window's first measure, before any scroll the user could make.
const ARRIVAL_MS = 80
// The open list shows at most six rows; the ones past them have nothing to show, so skip the work.
const RISING_ROWS = 8

/** A row's fade and rise wrapper. Whether it rises is decided once, as it mounts. */
function WorkerDockRise({
  rise,
  delay,
  children
}: {
  rise: boolean
  delay: string
  children: ReactNode
}) {
  const [rises] = useState(rise)
  return (
    <div
      data-worker-dock-morph-row=""
      data-worker-dock-rise={rises ? '' : undefined}
      style={{ animationDelay: delay }}
    >
      {children}
    </div>
  )
}

/** The open card's drawn rows, agents then background commands. With both listed, each set is its
 *  own named group and a quiet label (not a focus stop) sits above the first command row. */
export function WorkerDockGroupedRows({
  items,
  drawn,
  agentRows,
  grouped,
  entering,
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
  /** The list is opening: the rows drawn with it rise in; rows a scroll mounts later show at once. */
  entering: boolean
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
  const [late, setLate] = useState(false)
  if (!entering && late) {
    setLate(false)
  }
  useEffect(() => {
    if (!entering) {
      return
    }
    const timer = setTimeout(() => setLate(true), ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [entering])
  const renderRow = (item: NativeChatToolRunDrawnRow, position: number) => {
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
        <WorkerDockRise
          rise={entering && !late && position < RISING_ROWS}
          delay={rowDelay(position)}
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
        </WorkerDockRise>
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
        {agents.map((item, position) => renderRow(item, position))}
      </div>
      <div {...(grouped && commands.length ? { role: 'group', 'aria-label': commandsLabel } : {})}>
        {commands.map((item, position) => renderRow(item, agents.length + position))}
      </div>
    </>
  )
}
