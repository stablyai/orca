export const FLEET_TREE_NODE_MAX_WIDTH_PX = 224
export const FLEET_TREE_BRANCH_GUTTER_PX = 6
export const FLEET_TEAM_TREE_INSET_PX = 12
const FLEET_TREE_NODE_MIN_WIDTH_PX = 176
const FLEET_PROJECT_BORDER_PX = 1

export type FleetTeamLayout = 'tree' | 'outline'

/** Fold a team into indented rows once its leaves no longer fit side by side at a readable node width. */
export function fleetTeamLayout(leafCount: number, viewWidth: number): FleetTeamLayout {
  const leafSlotPx = FLEET_TREE_NODE_MIN_WIDTH_PX + 2 * FLEET_TREE_BRANCH_GUTTER_PX
  const treeWidthPx = viewWidth - 2 * (FLEET_PROJECT_BORDER_PX + FLEET_TEAM_TREE_INSET_PX)
  return leafCount * leafSlotPx <= treeWidthPx ? 'tree' : 'outline'
}
