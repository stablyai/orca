import { parseExecutionHostId } from './execution-host'
import { z } from 'zod'
import type { ExecutionHostId } from './execution-host'
import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { parseWslUncPath } from './wsl-paths'
import { rewriteWorktreeIdPath } from './worktree/id'
import { ImmutableInputCache, absentImmutableInput } from './immutable-input-cache'

export const WORKSPACE_PRESENTATION_PREFIX = 'workspacePresentation:v1:'
export type WorkspacePresentationKey = `workspacePresentation:v1:${string}`
export type WorkspaceSourceRef = {
  hostId: ExecutionHostId
  executionHostId?: ExecutionHostId
  workspaceId: string
}
export type WorkspaceEntityRef = Pick<Tab, 'contentType' | 'entityId'> & {
  hostId: ExecutionHostId
}
export type WorkspaceTabPresentation = Pick<
  Tab,
  'id' | 'groupId' | 'customLabel' | 'color' | 'isPinned' | 'viewMode' | 'lastFocusedAt'
> & { entity: WorkspaceEntityRef }
export type WorkspaceSourceBaseline = {
  source: WorkspaceSourceRef
  tabs: WorkspaceTabPresentation[]
  groups: TabGroup[]
  layout?: TabGroupLayoutNode
  activeGroupId?: string
}
export type WorkspacePresentation = {
  schemaVersion: 1
  owner: 'window' | 'main'
  anchor: WorkspaceSourceRef
  displayWorkspaceId: string
  tabs: WorkspaceTabPresentation[]
  groups: TabGroup[]
  layout?: TabGroupLayoutNode
  activeGroupId?: string
  baseline: WorkspaceSourceBaseline[]
}
export type WorkspacePresentationDocuments = Partial<
  Record<WorkspacePresentationKey, WorkspacePresentation>
>

/** Owning path syntax, never viewer-platform or Unicode normalization. */
export function strictWorktreeIdentityKey(id: string): string {
  return rewriteWorktreeIdPath(id, (path) => {
    const wsl = parseWslUncPath(path)
    if (wsl) {
      return `wsl:${wsl.distro.toLowerCase()}:${wsl.linuxPath}`
    }
    if (/^[a-z]:[/\\]/i.test(path) || /^[/\\]{2}[^/\\]+[/\\]/.test(path)) {
      return path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    }
    return path
  })
}

export function workspacePresentationKey(
  owner: WorkspacePresentation['owner'],
  source: WorkspaceSourceRef
): WorkspacePresentationKey {
  return `${WORKSPACE_PRESENTATION_PREFIX}${encodeURIComponent(
    JSON.stringify([
      owner,
      source.executionHostId ?? source.hostId,
      strictWorktreeIdentityKey(source.workspaceId)
    ])
  )}`
}

export function isWorkspacePresentationKey(key: string): key is WorkspacePresentationKey {
  return key.startsWith(WORKSPACE_PRESENTATION_PREFIX)
}

const layoutSchema: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), groupId: z.string() }),
    z.object({
      type: z.literal('split'),
      direction: z.enum(['horizontal', 'vertical']),
      first: layoutSchema,
      second: layoutSchema,
      ratio: z.number().min(0).max(1).optional()
    })
  ])
)
const hostSchema = z.custom<ExecutionHostId>(
  (v) => typeof v === 'string' && Boolean(parseExecutionHostId(v))
)
const sourceSchema = z.object({
  hostId: hostSchema,
  executionHostId: hostSchema.optional(),
  workspaceId: z.string()
})
const groupSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  activeTabId: z.string().nullable(),
  tabOrder: z.array(z.string()),
  recentTabIds: z.array(z.string()).optional()
})
const tabSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  customLabel: z.string().nullable(),
  color: z.string().nullable(),
  isPinned: z.boolean().optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  lastFocusedAt: z.number().optional(),
  entity: z.object({
    hostId: sourceSchema.shape.hostId,
    entityId: z.string(),
    contentType: z.enum([
      'terminal',
      'editor',
      'diff',
      'conflict-review',
      'check-details',
      'agent-session',
      'browser',
      'simulator'
    ])
  })
})
const baselineSchema = z.object({
  source: sourceSchema,
  tabs: z.array(tabSchema),
  groups: z.array(groupSchema),
  layout: layoutSchema.optional(),
  activeGroupId: z.string().optional()
})
const presentationSchema: z.ZodType<WorkspacePresentation> = z.object({
  schemaVersion: z.literal(1),
  owner: z.enum(['window', 'main']),
  anchor: sourceSchema,
  displayWorkspaceId: z.string(),
  tabs: z.array(tabSchema),
  groups: z.array(groupSchema),
  layout: layoutSchema.optional(),
  activeGroupId: z.string().optional(),
  baseline: z.array(baselineSchema)
})

export function readWorkspacePresentations(root: object): WorkspacePresentationDocuments {
  const result: WorkspacePresentationDocuments = {}
  for (const [key, value] of Object.entries(root)) {
    if (!isWorkspacePresentationKey(key)) {
      continue
    }
    const parsed = presentationSchema.safeParse(value)
    if (parsed.success && key === workspacePresentationKey(parsed.data.owner, parsed.data.anchor)) {
      result[key] = parsed.data
    }
  }
  return result
}

export function tabPresentation(tab: Tab, hostId: ExecutionHostId): WorkspaceTabPresentation {
  return {
    id: tab.id,
    groupId: tab.groupId,
    customLabel: tab.customLabel,
    color: tab.color,
    isPinned: tab.isPinned,
    viewMode: tab.viewMode,
    lastFocusedAt: tab.lastFocusedAt,
    entity: {
      hostId: tab.executionHostId ?? hostId,
      entityId: tab.entityId,
      contentType: tab.contentType
    }
  }
}
/** Only row-qualified physical/transport aliases belong to this source. */
export function workspaceSourceOwnsTab(
  tab: Pick<Tab, 'executionHostId'>,
  source: WorkspaceSourceRef
): boolean {
  return (
    !tab.executionHostId ||
    tab.executionHostId === source.hostId ||
    tab.executionHostId === source.executionHostId
  )
}

export function sourceTabPresentation(
  tab: Tab,
  source: WorkspaceSourceRef
): WorkspaceTabPresentation {
  return { ...tabPresentation(tab, source.hostId), entity: sourceTabEntity(tab, source) }
}

export function sourceTabEntity(
  tab: Pick<Tab, 'executionHostId' | 'contentType' | 'entityId'>,
  source: WorkspaceSourceRef
): WorkspaceEntityRef {
  // The saved association contains row-qualified physical-host evidence, distinct from transport.
  const executionHostId =
    source.executionHostId && (!tab.executionHostId || tab.executionHostId === source.hostId)
      ? source.executionHostId
      : tab.executionHostId
  return {
    hostId: executionHostId ?? source.executionHostId ?? source.hostId,
    contentType: tab.contentType,
    entityId: tab.entityId
  }
}
export function workspaceEntityKey(entity: WorkspaceEntityRef): string {
  return JSON.stringify([entity.hostId, entity.contentType, entity.entityId])
}
const baselineCaches = new ImmutableInputCache<WorkspaceSourceBaseline>()

export function sourceBaseline(
  session: WorkspaceSessionState,
  source: WorkspaceSourceRef
): WorkspaceSourceBaseline {
  const id = source.workspaceId
  const tabs = session.unifiedTabs?.[id]
  const groups = session.tabGroups?.[id]
  const layout = session.tabGroupLayouts?.[id]
  const active = session.activeGroupIdByWorktree?.[id]
  const key = JSON.stringify([source.hostId, source.executionHostId, id, active])
  const inputs = [
    tabs ?? absentImmutableInput,
    groups ?? absentImmutableInput,
    layout ?? absentImmutableInput
  ]
  const old = baselineCaches.get(inputs, key)
  if (old) {
    return old
  }
  const baseline = {
    source,
    tabs: (tabs ?? [])
      .filter((tab) => workspaceSourceOwnsTab(tab, source))
      .map((tab) => sourceTabPresentation(tab, source)),
    groups: groups ?? [],
    layout,
    activeGroupId: active
  }
  baselineCaches.set(inputs, key, baseline)
  return baseline
}

export function prunePresentationLayout(
  root: TabGroupLayoutNode | undefined,
  groups: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!root) {
    return undefined
  }
  if (root.type === 'leaf') {
    return groups.has(root.groupId) ? root : undefined
  }
  const first = prunePresentationLayout(root.first, groups)
  const second = prunePresentationLayout(root.second, groups)
  return first && second
    ? first === root.first && second === root.second
      ? root
      : { ...root, first, second }
    : (first ?? second)
}

export type WorkspacePresentationCommit = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  mode: 'patch' | 'replace'
  presentations: WorkspacePresentationDocuments
  removedPresentations?: WorkspacePresentationKey[]
  replacePresentations?: boolean
}

export type WorkspacePresentationDelta = {
  changed: WorkspacePresentationDocuments
  removed: readonly string[]
}
