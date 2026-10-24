import { z } from 'zod'
import { normalizeExecutionHostId } from './execution-host'
import type { ProjectHostSetupMethod } from './project-types'
import type { ProjectGroup, ProjectGroupCreatedFrom } from './project-group-types'
import type { RepoKind } from './repo-types'
import type { ProjectOrderBy } from './ui-chrome-types'
import { hostUnionArms, salvagedOptional, salvagingArray } from './zod-salvage'

// The sidebar's project catalog as a reader parses it, from mobileRelay.projectSections or the
// sidebar feed's projectCatalog domain (MobileProjectSectionCatalog is what a host sends).

const SETUP_METHOD_ARMS = hostUnionArms<ProjectHostSetupMethod>({
  'legacy-repo': true,
  'imported-existing-folder': true,
  cloned: true,
  provisioned: true
})
const REPO_KIND_ARMS = hostUnionArms<RepoKind>({ git: true, folder: true })
const PROJECT_ORDER_BY_ARMS = hostUnionArms<ProjectOrderBy>({
  manual: true,
  recent: true,
  name: true
})

// A host id the desktop spells; normalized, so a spelling this build cannot read drops.
const hostIdSchema = z.string().transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'unknown host id' })
    return z.NEVER
  }
  return hostId
})

const repoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  badgeColor: salvagedOptional('badgeColor', z.string()),
  addedAt: salvagedOptional('addedAt', z.number()),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', hostIdSchema),
  // Older desktops omit both; the project then lists ungrouped, as it did.
  projectGroupId: salvagedOptional('projectGroupId', z.string().nullable()),
  projectGroupOrder: salvagedOptional('projectGroupOrder', z.number()),
  // Decoded where drawn (readMobileRepoIcon), so an arm this build lacks still keeps the row.
  repoIcon: z.unknown().optional()
})

const setupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  hostId: hostIdSchema,
  repoId: z.string(),
  path: z.string(),
  displayName: z.string(),
  // Why the fallback: only 'provisioned' changes grouping, so a newer arm groups as a checkout.
  setupMethod: z.enum(SETUP_METHOD_ARMS).catch('legacy-repo'),
  kind: salvagedOptional('kind', z.enum(REPO_KIND_ARMS)),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', hostIdSchema)
})

const PROJECT_GROUP_CREATED_FROM_ARMS = hostUnionArms<ProjectGroupCreatedFrom>({
  manual: true,
  'folder-scan': true,
  migration: true
})

export const ProjectGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentPath: z.string().nullable(),
  connectionId: salvagedOptional('connectionId', z.string().nullable()),
  executionHostId: salvagedOptional('executionHostId', z.string().nullable()),
  parentGroupId: z.string().nullable(),
  createdFrom: z.enum(PROJECT_GROUP_CREATED_FROM_ARMS).catch('manual'),
  tabOrder: z.number(),
  isCollapsed: z.boolean(),
  color: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
}) satisfies z.ZodType<ProjectGroup, unknown>

export const ProjectSectionCatalogSchema = z.object({
  repos: salvagingArray(repoSchema),
  projects: salvagingArray(z.object({ id: z.string(), displayName: z.string() })),
  setups: salvagingArray(setupSchema),
  // Until the phone has read the shared UI value (projectOrderBy, ui.get), it orders by this.
  projectOrderBy: z.enum(PROJECT_ORDER_BY_ARMS).catch('manual'),
  // Every host's project groups, for a list built from the sidebar feed; older desktops omit it.
  projectGroups: salvagedOptional('projectGroups', salvagingArray(ProjectGroupSchema))
})

/** The desktop sidebar's Project grouping inputs, as a reader holds them. */
export type ServedProjectSections = z.output<typeof ProjectSectionCatalogSchema>
