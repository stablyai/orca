/** Which card draws workspaces in the sidebar, and the values people set for its options. */
export type WorkspaceCardSettings = {
  /** A plugin card, `plugin:<pluginKey>/<cardId>`; unset draws Orca's card. */
  workspaceCardId?: string
  /** Option values by card id, then option key; unset keys use the card's declared defaults. */
  workspaceCardOptions?: Record<string, Record<string, string | number | boolean>>
  /** A plugin list arrangement, `plugin:<pluginKey>/<listId>`; unset keeps Orca's grouping. */
  workspaceListId?: string
}
