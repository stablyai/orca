import { cn } from '@/lib/class-names'
import { FleetNetworkNode } from './FleetNetworkNode'
import { FLEET_GUIDE_LINE_CLASS, FleetTreeGuides } from './FleetTreeGuides'
import { flattenFleetTree } from './fleet-tree-rows'
import type { FleetNode } from './fleet-view-model'

export function FleetNetworkOutline({
  root,
  now
}: {
  root: FleetNode
  now: number
}): React.JSX.Element {
  return (
    <div>
      {flattenFleetTree(root).map((row) => (
        <div key={row.card.paneKey} className="relative flex">
          <FleetTreeGuides row={row} geometry="card" />
          <div className="relative min-w-0 flex-1 py-1">
            <FleetNetworkNode card={row.card} now={now} />
            {row.hasChildren ? (
              <span
                aria-hidden
                className={cn('absolute bottom-0 left-2.5 h-1 border-l', FLEET_GUIDE_LINE_CLASS)}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
