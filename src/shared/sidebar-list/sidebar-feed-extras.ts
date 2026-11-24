import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate
} from './row-types'

/** What a reader adds over the inputs: the desktop window's transient reveals and cards, and either side's Bots listing. */
export type SidebarFeedWindowExtras = {
  forcedVisibleWorktreeIds?: readonly string[]
  /** Host identities a Bots section lists instead of their project; see withoutBotListedWorktrees. */
  botListedWorktreeIdentities?: ReadonlySet<string>
  importedWorktreesByRepo?: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo?: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
}
