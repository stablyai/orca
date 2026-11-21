export const FLEET_TREE_NODE_MAX_WIDTH_PX = 224
export const FLEET_TREE_BRANCH_GUTTER_PX = 6
export const FLEET_TEAM_TREE_INSET_PX = 12
const FLEET_TREE_NODE_MIN_WIDTH_PX = 176
const FLEET_PROJECT_BORDER_PX = 1

export type FleetTeamLayout = 'tree' | 'outline'

type FleetTreeShape = { readonly children: readonly FleetTreeShape[] }

/** The narrowest branch that keeps its own node and every node below it at a readable width, gutters included. */
export function fleetTreeMinWidthPx(node: FleetTreeShape): number {
  const childrenPx = node.children.reduce((total, child) => total + fleetTreeMinWidthPx(child), 0)
  return 2 * FLEET_TREE_BRANCH_GUTTER_PX + Math.max(FLEET_TREE_NODE_MIN_WIDTH_PX, childrenPx)
}

/** Fold a team into indented rows once its tree no longer fits with every node at a readable width. */
export function fleetTeamLayout(root: FleetTreeShape, viewWidth: number): FleetTeamLayout {
  const treeWidthPx = viewWidth - 2 * (FLEET_PROJECT_BORDER_PX + FLEET_TEAM_TREE_INSET_PX)
  return fleetTreeMinWidthPx(root) <= treeWidthPx ? 'tree' : 'outline'
}
