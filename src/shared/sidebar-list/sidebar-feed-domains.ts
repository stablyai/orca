import { z } from 'zod'
import { DesktopSidebarFactsSchema, type DesktopSidebarFacts } from './desktop-sidebar-facts'
import type { InstalledSidebarInputs } from './sidebar-inputs-feed-installer'
import {
  PairedServerRowsSnapshotSchema,
  type PairedServerHostFacts,
  type PairedServerWorkspaceRow
} from './paired-server-rows'
import { SidebarTemporalSnapshotSchema, type SidebarRetention } from './sidebar-temporal-snapshot'
import {
  WorkspaceActivityFactsSnapshotSchema,
  type WorkspaceActivityFacts
} from './workspace-activity-facts'
import { WorkspaceCreationsSnapshotSchema, type WorkspaceCreation } from './workspace-creations'
import {
  WorkspaceReviewFactsSnapshotSchema,
  type WorkspaceReviewFact
} from './workspace-review-facts'
import { WorkspaceRowsSnapshotSchema, type WorkspaceRow } from './workspace-rows'

/** One installed feed, typed per domain; an entity this build cannot parse is left out. */
export type SidebarFeedDomains = {
  workspaces: ReadonlyMap<string, WorkspaceRow>
  activity: ReadonlyMap<string, WorkspaceActivityFacts>
  review: ReadonlyMap<string, WorkspaceReviewFact>
  creations: ReadonlyMap<string, WorkspaceCreation>
  pairedServerHosts: ReadonlyMap<
    string,
    { freshness: 'live' | 'unverifiable'; host: PairedServerHostFacts | null }
  >
  pairedServerRows: ReadonlyMap<string, PairedServerWorkspaceRow>
  /** Icon ids by `hostId|repoId` (repoIconFeedKey) for this host's repos; a paired server's have none. */
  repoIcons: ReadonlyMap<string, string>
  /** Null until the host's desktop facts arrive whole. */
  desktop: DesktopSidebarFacts | null
  retention: SidebarRetention | null
}

const entitySchemas = {
  workspaces: WorkspaceRowsSnapshotSchema.shape.rows.valueType,
  activity: WorkspaceActivityFactsSnapshotSchema.shape.facts.valueType,
  review: WorkspaceReviewFactsSnapshotSchema.shape.facts.valueType,
  creations: WorkspaceCreationsSnapshotSchema.shape.creations.valueType,
  pairedServerHosts: PairedServerRowsSnapshotSchema.shape.servers.element.pick({
    freshness: true,
    host: true
  }),
  pairedServerRows: PairedServerRowsSnapshotSchema.shape.servers.element.shape.rows.element,
  repoIcons: z.string()
}

function readDomain<Schema extends z.ZodType>(
  installed: InstalledSidebarInputs,
  name: string,
  schema: Schema
): Map<string, z.infer<Schema>> {
  const entities = new Map<string, z.infer<Schema>>()
  for (const [key, value] of installed.domains.get(name) ?? []) {
    const parsed = schema.safeParse(value)
    if (parsed.success) {
      entities.set(key, parsed.data)
    }
  }
  return entities
}

/** An install and what was read off it, for the next read to reuse. */
export type SidebarFeedRead = { installed: InstalledSidebarInputs; domains: SidebarFeedDomains }

/** The domains main publishes (sidebar-inputs-feed-domains.ts), read off an installed feed. */
export function readSidebarFeedDomains(
  installed: InstalledSidebarInputs,
  previous?: SidebarFeedRead
): SidebarFeedDomains {
  // A batch leaves a domain it did not touch as the same map, so its entities keep their identity.
  const unchanged = (name: string): SidebarFeedDomains | undefined =>
    previous && installed.domains.get(name) === previous.installed.domains.get(name)
      ? previous.domains
      : undefined
  // The desktop and temporal domains publish each field as its own entity.
  const desktop = DesktopSidebarFactsSchema.safeParse(
    Object.fromEntries(installed.domains.get('desktop') ?? [])
  )
  const temporal = SidebarTemporalSnapshotSchema.pick({ retention: true }).safeParse(
    Object.fromEntries(installed.domains.get('temporal') ?? [])
  )
  return {
    workspaces:
      unchanged('workspaces')?.workspaces ??
      readDomain(installed, 'workspaces', entitySchemas.workspaces),
    activity:
      unchanged('activity')?.activity ?? readDomain(installed, 'activity', entitySchemas.activity),
    review: unchanged('review')?.review ?? readDomain(installed, 'review', entitySchemas.review),
    creations:
      unchanged('creations')?.creations ??
      readDomain(installed, 'creations', entitySchemas.creations),
    pairedServerHosts:
      unchanged('pairedServerHosts')?.pairedServerHosts ??
      readDomain(installed, 'pairedServerHosts', entitySchemas.pairedServerHosts),
    pairedServerRows:
      unchanged('pairedServerRows')?.pairedServerRows ??
      readDomain(installed, 'pairedServerRows', entitySchemas.pairedServerRows),
    repoIcons:
      unchanged('repoIcons')?.repoIcons ??
      readDomain(installed, 'repoIcons', entitySchemas.repoIcons),
    desktop: desktop.success ? desktop.data : null,
    retention: temporal.success ? temporal.data.retention : null
  }
}
