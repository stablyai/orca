import { cn } from '@/lib/class-names'
import { FleetNetworkNode } from './FleetNetworkNode'
import { countFleetLeaves } from './fleet-tree-rows'
import type { FleetNode } from './fleet-view-model'

const CHILD_LIST_CLASS = cn(
  'relative flex self-stretch pt-4',
  'before:absolute before:top-0 before:left-1/2 before:h-4 before:border-l before:border-muted-foreground/30'
)

const BRANCH_CLASS = cn(
  'relative flex min-w-0 basis-0 flex-col items-center px-1.5 pt-4',
  'before:absolute before:top-0 before:right-1/2 before:h-4 before:w-1/2 before:border-t',
  'after:absolute after:top-0 after:left-1/2 after:h-4 after:w-1/2 after:border-t after:border-l',
  'before:border-muted-foreground/30 after:border-muted-foreground/30',
  'first:before:border-0 first:after:rounded-tl-md',
  'last:after:border-0 last:before:border-r last:before:rounded-tr-md',
  'only:pt-0 only:before:hidden only:after:hidden'
)

function FleetNetworkBranch({ node, now }: { node: FleetNode; now: number }): React.JSX.Element {
  return (
    <li className={BRANCH_CLASS} style={{ flexGrow: countFleetLeaves(node) }}>
      <FleetNetworkNode card={node.card} now={now} className="max-w-56" />
      {node.children.length > 0 ? (
        <ul className={CHILD_LIST_CLASS}>
          {node.children.map((child) => (
            <FleetNetworkBranch key={child.card.paneKey} node={child} now={now} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function FleetNetworkTree({
  root,
  now
}: {
  root: FleetNode
  now: number
}): React.JSX.Element {
  return (
    <ul className="flex">
      <FleetNetworkBranch node={root} now={now} />
    </ul>
  )
}
