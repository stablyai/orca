import { translate } from '../../i18n/i18n'
import {
  MAX_SESSION_LIST_HEIGHT,
  sessionListHeight
} from '../../../../shared/notch/notch-panel-rect'
import type { NotchRow } from '../../../../shared/notch/notch-snapshot'
import { NotchSessionRow } from './NotchSessionRow'

export function NotchSessionList({
  rows,
  onActivate
}: {
  rows: NotchRow[]
  onActivate: (row: NotchRow) => void
}): React.JSX.Element {
  return (
    <div
      // Height matches what main sized the window to, so the card never clips or floats.
      style={{ height: sessionListHeight(rows.length), maxHeight: MAX_SESSION_LIST_HEIGHT }}
      className="scrollbar-sleek overflow-y-auto overflow-x-hidden px-2"
      role="list"
      aria-label={translate('notch.sessionList', 'Agent sessions')}
    >
      {rows.map((row) => (
        <div key={row.paneKey} role="listitem">
          <NotchSessionRow row={row} onActivate={onActivate} />
        </div>
      ))}
    </div>
  )
}
