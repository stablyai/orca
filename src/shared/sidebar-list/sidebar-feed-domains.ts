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
import {
  parseWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'
import {
  ProjectSectionCatalogSchema,
  type ServedProjectSections
} from '../project-section-catalog-schema'

/** One installed feed, typed per domain; an entity this build cannot parse is left out. */
export type SidebarFeedDomains = {
  /** Workspace facts are keyed by row identity: the same id on two hosts is two workspaces. */
  workspaces: ReadonlyMap<HostScopedWorktreeKey, WorkspaceRow>
  activity: ReadonlyMap<HostScopedWorktreeKey, WorkspaceActivityFacts>
  review: ReadonlyMap<HostScopedWorktreeKey, WorkspaceReviewFact>
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
  /** Every host's repos, project groups and projects, in header order; null from a host that predates it. */
  projectCatalog: ServedProjectSections | null
  /** Retained rows by identity; an entry that is not one (a bare id) keeps nothing. */
  retention: SidebarFeedRetention | null
}

export type SidebarFeedRetention = Omit<SidebarRetention, 'retainedIds'> & {
  retainedIds: readonly HostScopedWorktreeKey[]
}

function readRetention(retention: SidebarRetention | null): SidebarFeedRetention | null {
  return retention
    ? {
        ...retention,
        retainedIds: retention.retainedIds.flatMap((id) => parseWorktreeHostIdentity(id) ?? [])
      }
    : null
}

type EntityParser<Entity> = (value: unknown) => { entity: Entity } | null

/** Remembers each raw entity's parse by object identity. The installer keeps an unchanged entity's
 *  object, so only a changed entity is parsed again, and only its parsed object changes. */
function entityParser<Schema extends z.ZodType>(schema: Schema): EntityParser<z.infer<Schema>> {
  const parsedByRaw = new WeakMap<object, { entity: z.infer<Schema> } | null>()
  return (value) => {
    const remembered =
      typeof value === 'object' && value !== null ? parsedByRaw.get(value) : undefined
    if (remembered !== undefined) {
      return remembered
    }
    const parsed = schema.safeParse(value)
    const read = parsed.success ? { entity: parsed.data } : null
    if (typeof value === 'object' && value !== null) {
      parsedByRaw.set(value, read)
    }
    return read
  }
}

const entityParsers = {
  workspaces: entityParser(WorkspaceRowsSnapshotSchema.shape.rows.valueType),
  activity: entityParser(WorkspaceActivityFactsSnapshotSchema.shape.facts.valueType),
  review: entityParser(WorkspaceReviewFactsSnapshotSchema.shape.facts.valueType),
  creations: entityParser(WorkspaceCreationsSnapshotSchema.shape.creations.valueType),
  pairedServerHosts: entityParser(
    PairedServerRowsSnapshotSchema.shape.servers.element.pick({
      freshness: true,
      host: true
    })
  ),
  pairedServerRows: entityParser(
    PairedServerRowsSnapshotSchema.shape.servers.element.shape.rows.element
  ),
  repoIcons: entityParser(z.string())
}

function readKeyedDomain<Entity, Key extends string>(
  installed: InstalledSidebarInputs,
  name: string,
  parse: EntityParser<Entity>,
  keyOf: (key: string) => Key | null
): Map<Key, Entity> {
  const entities = new Map<Key, Entity>()
  for (const [rawKey, value] of installed.domains.get(name) ?? []) {
    const key = keyOf(rawKey)
    const read = key === null ? null : parse(value)
    if (key !== null && read) {
      entities.set(key, read.entity)
    }
  }
  return entities
}

const readDomain = <Entity>(
  installed: InstalledSidebarInputs,
  name: string,
  parse: EntityParser<Entity>
): Map<string, Entity> => readKeyedDomain(installed, name, parse, (key) => key)

// A key that is not a row identity (a bare id) is not one of this build's workspace entities.
const readWorkspaceDomain = <Entity>(
  installed: InstalledSidebarInputs,
  name: string,
  parse: EntityParser<Entity>
): Map<HostScopedWorktreeKey, Entity> =>
  readKeyedDomain(installed, name, parse, parseWorktreeHostIdentity)

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
  // The desktop, temporal and projectCatalog domains publish each field as its own entity.
  const desktop = DesktopSidebarFactsSchema.safeParse(
    Object.fromEntries(installed.domains.get('desktop') ?? [])
  )
  const projectCatalog =
    unchanged('projectCatalog')?.projectCatalog ??
    ProjectSectionCatalogSchema.safeParse(
      Object.fromEntries(installed.domains.get('projectCatalog') ?? [])
    ).data ??
    null
  const temporal = SidebarTemporalSnapshotSchema.pick({ retention: true }).safeParse(
    Object.fromEntries(installed.domains.get('temporal') ?? [])
  )
  return {
    workspaces:
      unchanged('workspaces')?.workspaces ??
      readWorkspaceDomain(installed, 'workspaces', entityParsers.workspaces),
    activity:
      unchanged('activity')?.activity ??
      readWorkspaceDomain(installed, 'activity', entityParsers.activity),
    review:
      unchanged('review')?.review ?? readWorkspaceDomain(installed, 'review', entityParsers.review),
    creations:
      unchanged('creations')?.creations ??
      readDomain(installed, 'creations', entityParsers.creations),
    pairedServerHosts:
      unchanged('pairedServerHosts')?.pairedServerHosts ??
      readDomain(installed, 'pairedServerHosts', entityParsers.pairedServerHosts),
    pairedServerRows:
      unchanged('pairedServerRows')?.pairedServerRows ??
      readDomain(installed, 'pairedServerRows', entityParsers.pairedServerRows),
    repoIcons:
      unchanged('repoIcons')?.repoIcons ??
      readDomain(installed, 'repoIcons', entityParsers.repoIcons),
    desktop: desktop.success ? desktop.data : null,
    projectCatalog,
    retention: temporal.success ? readRetention(temporal.data.retention) : null
  }
}
