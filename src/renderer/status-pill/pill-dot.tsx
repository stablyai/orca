import type { Tone } from './status-pill-formatters'

/** Idle mode: a tiny glowing light. Hovering the stack reveals the full bar
 *  (PillBody), so the dot itself is just a passive indicator that still
 *  forwards a click to focus the Orca main window. Kept in its own module so
 *  the renderer root stays under the per-file line budget. */
export function PillDot({
  tone,
  pulse,
  onClick,
  onContextMenu
}: {
  tone: Tone
  pulse: boolean
  onClick: () => void
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Orca agent status"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      className={`pill-dot pill-${tone} ${pulse ? 'pill-pulse' : ''}`}
    >
      <span className="indicator" aria-hidden="true">
        <span className="indicator-ring" />
        <span className="indicator-dot" />
      </span>
    </div>
  )
}
