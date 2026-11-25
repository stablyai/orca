import { createPortal } from 'react-dom'
import { DropdownMenuTrigger } from './dropdown-menu'
import { usePortalContainer } from './portal-container-context'

/** Keep the pointer anchor in viewport coordinates when the clicked row scrolls, moves or scales. */
export function ViewportDropdownMenuTrigger({ point }: { point: { x: number; y: number } }) {
  return createPortal(
    <DropdownMenuTrigger asChild>
      <button
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed size-px opacity-0"
        style={{ left: point.x, top: point.y, zoom: 'calc(1 / var(--web-panel-zoom, 1))' }}
      />
    </DropdownMenuTrigger>,
    usePortalContainer() ?? document.body
  )
}
