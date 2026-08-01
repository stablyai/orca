import { translate } from '@/i18n/i18n'
import type {
  PeerPresenceSelection,
  PeerPresenceState
} from '../../../../shared/peer-presence-event'

type CellMetrics = { cellWidth: number; cellHeight: number; cols: number }

/**
 * Absolute-position layer drawn over a terminal to show other participants'
 * cursors and selections. Never touches xterm's own rendering or input path
 * — it only reads grid coordinates already computed by the caller and
 * projects them to pixels.
 */
export function RemoteTerminalPresenceOverlay({
  participants,
  metrics
}: {
  participants: PeerPresenceState[]
  metrics: CellMetrics
}): React.JSX.Element | null {
  if (metrics.cellWidth <= 0 || metrics.cellHeight <= 0) {
    return null
  }
  const scrolledAway = participants.filter((state) => !state.scroll.atBottom)
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {participants.map((state) => (
        <RemoteParticipantMarker key={state.participant.clientId} state={state} metrics={metrics} />
      ))}
      {scrolledAway.length > 0 ? <ScrolledAwayBadges participants={scrolledAway} /> : null}
    </div>
  )
}

// Why: a participant scrolled off the live tail has no cursor/selection to
// anchor a marker to, so their scroll state needs its own indicator rather
// than being folded into RemoteParticipantMarker.
function ScrolledAwayBadges({
  participants
}: {
  participants: PeerPresenceState[]
}): React.JSX.Element {
  return (
    <div className="absolute top-1 right-1 flex flex-col items-end gap-1">
      {participants.map((state) => (
        <div
          key={state.participant.clientId}
          className="w-max max-w-[160px] truncate rounded-xs px-1 py-0.5 text-[10px] leading-none text-white"
          style={{ backgroundColor: state.participant.color }}
        >
          {state.participant.name} ·{' '}
          {translate(
            'auto.components.peer-collab.RemoteTerminalPresenceOverlay.scrolledUp',
            'scrolled up'
          )}
        </div>
      ))}
    </div>
  )
}

function RemoteParticipantMarker({
  state,
  metrics
}: {
  state: PeerPresenceState
  metrics: CellMetrics
}): React.JSX.Element {
  const { cursor, selection, participant } = state
  return (
    <>
      {selection ? (
        <SelectionHighlight selection={selection} color={participant.color} metrics={metrics} />
      ) : null}
      {cursor ? (
        <div
          className="absolute"
          style={{
            left: cursor.col * metrics.cellWidth,
            top: cursor.row * metrics.cellHeight,
            width: metrics.cellWidth,
            height: metrics.cellHeight
          }}
        >
          <div className="h-full w-[2px]" style={{ backgroundColor: participant.color }} />
          <div
            className="-mt-4 w-max max-w-[140px] truncate rounded-xs px-1 py-0.5 text-[10px] leading-none text-white"
            style={{ backgroundColor: participant.color }}
          >
            {participant.name}
          </div>
        </div>
      ) : null}
    </>
  )
}

function SelectionHighlight({
  selection,
  color,
  metrics
}: {
  selection: NonNullable<PeerPresenceSelection>
  color: string
  metrics: CellMetrics
}): React.JSX.Element {
  const rows: { left: number; top: number; width: number }[] =
    selection.startRow === selection.endRow
      ? [
          {
            left: selection.startCol,
            top: selection.startRow,
            width: selection.endCol - selection.startCol
          }
        ]
      : [
          {
            left: selection.startCol,
            top: selection.startRow,
            width: metrics.cols - selection.startCol
          },
          ...Array.from(
            { length: Math.max(0, selection.endRow - selection.startRow - 1) },
            (_, i) => ({
              left: 0,
              top: selection.startRow + 1 + i,
              width: metrics.cols
            })
          ),
          { left: 0, top: selection.endRow, width: selection.endCol }
        ]
  return (
    <>
      {rows.map((row, index) => (
        <div
          key={index}
          className="absolute opacity-25"
          style={{
            left: row.left * metrics.cellWidth,
            top: row.top * metrics.cellHeight,
            width: Math.max(0, row.width) * metrics.cellWidth,
            height: metrics.cellHeight,
            backgroundColor: color
          }}
        />
      ))}
    </>
  )
}
