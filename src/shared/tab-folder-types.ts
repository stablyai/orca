export type TabFolderGroup = {
  id: string
  worktreeId: string
  /** Split-pane group this folder lives in. Existing `tab-group` code is panes, not folders. */
  splitGroupId: string
  name: string
  color: string
  collapsed: boolean
  tabOrder: string[]
  sortOrder: number
  createdAt: number
}
