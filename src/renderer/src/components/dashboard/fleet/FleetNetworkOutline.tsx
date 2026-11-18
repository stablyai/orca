import { cn } from '@/lib/class-names'
import { FleetNetworkNode, type FleetCardOpener } from './FleetNetworkNode'
import { FLEET_GUIDE_LINE_CLASS, FleetTreeGuides } from './FleetTreeGuides'
import { flattenFleetTree } from './fleet-tree-rows'
import type { FleetNode } from './fleet-view-model'

export function FleetNetworkOutline({
  root,
  now,
  onOpenCard
}: {
  root: FleetNode
  now: number
  onOpenCard: FleetCardOpener
}): React.JSX.Element {
  return (
    <div>
      {flattenFleetTree(root).map((row) => (
        <div key={row.card.paneKey} className="relative flex">
          <FleetTreeGuides row={row} />
          <div className="relative min-w-0 flex-1 py-1">
            <FleetNetworkNode card={row.card} now={now} onOpenCard={onOpenCard} />
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
