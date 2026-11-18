export const FLEET_TREE_NODE_MAX_WIDTH_PX = 224
export const FLEET_TREE_BRANCH_GUTTER_PX = 6
const FLEET_TREE_NODE_MIN_WIDTH_PX = 176
const TEAM_BORDER_AND_PADDING_PX = 13

export type FleetTeamLayout = 'tree' | 'outline'

/** Fold a team into indented rows once its leaves no longer fit side by side at a readable node width. */
export function fleetTeamLayout(leafCount: number, viewWidth: number): FleetTeamLayout {
  const leafSlotPx = FLEET_TREE_NODE_MIN_WIDTH_PX + 2 * FLEET_TREE_BRANCH_GUTTER_PX
  return leafCount * leafSlotPx <= viewWidth - 2 * TEAM_BORDER_AND_PADDING_PX ? 'tree' : 'outline'
}
