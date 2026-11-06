/** A named, purely-visual sidebar section grouping worktrees across repos via collectionIds. */
export type Collection = {
  id: string
  name: string
  color: string | null
  isCollapsed: boolean
  /** Manual ordering among collection sections; lower renders first. */
  order: number
  createdAt: number
  updatedAt: number
}
