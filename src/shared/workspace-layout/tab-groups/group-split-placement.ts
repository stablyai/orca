export type GroupSide = 'left' | 'right' | 'up' | 'down'

/** Create a split group and its first tab atomically, never storing an empty group.
 * An optional last-group ID expands the target to a branch, supporting window-retained empty groups beside later splits. */
export type NewGroupSplit = {
  besideGroupId: string
  besideLastGroupId?: string
  direction: GroupSide
}
