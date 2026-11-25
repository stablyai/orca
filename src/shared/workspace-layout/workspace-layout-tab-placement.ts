import type { NewGroupSplit } from './workspace-layout-command-types'

/** Where a window put a content tab it drew. */
export type DrawnTabPlacement = {
  groupId?: string
  /** Placement in the group: after this tab, else at this index, else at its end. */
  afterTabId?: string
  index?: number
  /** When the window drew the tab, so a later save of it matches main's copy. */
  createdAt?: number
  split?: NewGroupSplit
}
