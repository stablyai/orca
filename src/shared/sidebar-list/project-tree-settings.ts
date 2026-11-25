export type ProjectTreeSettings = {
  /** Experimental: the "Tree" card style — project sidebar as an explicit tree with Chats and Worktrees. */
  experimentalProjectTree?: boolean
}

/** The Tree card style builds on the new card style, so it is on only while both are. */
export function isProjectTreeOn(
  settings:
    | ({ experimentalNewWorktreeCardStyle?: boolean } & ProjectTreeSettings)
    | null
    | undefined
): boolean {
  return (
    settings?.experimentalNewWorktreeCardStyle === true && settings.experimentalProjectTree === true
  )
}

/** Whether the sidebar lists each project's Chats: the Tree style while grouped by project (the default). */
export function showsProjectChats(
  settings: Parameters<typeof isProjectTreeOn>[0],
  groupBy: string | undefined
): boolean {
  return isProjectTreeOn(settings) && (groupBy === undefined || groupBy === 'repo')
}
