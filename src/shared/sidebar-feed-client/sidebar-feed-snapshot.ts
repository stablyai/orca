import { SIDEBAR_INPUTS_SEMANTICS_VERSION } from '../sidebar-list/sidebar-inputs-feed-contract'
import type { InstalledSidebarInputs } from '../sidebar-list/sidebar-inputs-feed-installer'
import {
  readSidebarFeedDomains,
  type SidebarFeedDomains,
  type SidebarFeedRead
} from '../sidebar-list/sidebar-feed-domains'

/** One host's installed feed and its typed domains; replaced whole on each install, never edited. */
export type SidebarFeedSnapshot = Readonly<SidebarFeedRead>

/** What this build's list rules mean; a host publishing another meaning would build another list. */
const READABLE_SIDEBAR_SEMANTICS_VERSIONS: readonly number[] = [SIDEBAR_INPUTS_SEMANTICS_VERSION]

export const EMPTY_SIDEBAR_FEED_DOMAINS: SidebarFeedDomains = {
  workspaces: new Map(),
  activity: new Map(),
  review: new Map(),
  creations: new Map(),
  pairedServerHosts: new Map(),
  pairedServerRows: new Map(),
  repoIcons: new Map(),
  desktop: null,
  projectCatalog: null,
  retention: null
}

/** The snapshot for `installed`; whatever it shares with `previous` keeps its object. */
export function installSidebarFeedSnapshot(
  installed: InstalledSidebarInputs,
  previous: SidebarFeedSnapshot | null
): SidebarFeedSnapshot {
  if (previous?.installed === installed) {
    return previous
  }
  return { installed, domains: readSidebarFeedDomains(installed, previous ?? undefined) }
}

export function isReadableSidebarFeed(snapshot: SidebarFeedSnapshot): boolean {
  return READABLE_SIDEBAR_SEMANTICS_VERSIONS.includes(snapshot.installed.semanticsVersion)
}
