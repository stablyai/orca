import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { FleetNode } from './fleet-view-model'

export type FleetTreeRow = {
  card: DashboardCard
  depth: number
  isLastSibling: boolean
  /** One entry per ancestor below the root: whether that ancestor's guide line continues past this row. */
  continuingAncestors: readonly boolean[]
  hasChildren: boolean
}

export function flattenFleetTree(root: FleetNode): FleetTreeRow[] {
  const rows: FleetTreeRow[] = []
  const visit = (node: FleetNode, isLastSibling: boolean, continuing: boolean[]): void => {
    rows.push({
      card: node.card,
      depth: node.depth,
      isLastSibling,
      continuingAncestors: continuing,
      hasChildren: node.children.length > 0
    })
    const childContinuing = node.depth === 0 ? [] : [...continuing, !isLastSibling]
    node.children.forEach((child, index) =>
      visit(child, index === node.children.length - 1, childContinuing)
    )
  }
  visit(root, true, [])
  return rows
}

export function countFleetLeaves(node: FleetNode): number {
  return node.children.length === 0
    ? 1
    : node.children.reduce((total, child) => total + countFleetLeaves(child), 0)
}
