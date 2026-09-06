/** A named, purely-visual sidebar section grouping worktrees across repos.
 *  Many-to-many with worktrees via WorktreeMeta.collectionIds; references
 *  existing checkouts only — never creates folders on disk. */
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
