import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotHomeOwner } from '../../../../../shared/bots/bot-homes'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey,
  type WorkspaceKey
} from '../../../../../shared/workspace/identity/workspace-scope'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { RuntimeStatuses } from '../runtime-status/views/runtime-status-subscriptions'
import { installAutoCollapseChildWorkspacesObserver } from './auto-collapse-child-workspaces-observer'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const EMPTY_STATUSES: RuntimeStatuses = new Map()

function makeWorktree(overrides: Partial<Worktree> & { id: string; instanceId: string }): Worktree {
  return {
    repoId: 'repo-1',
    path: `/tmp/${overrides.id}`,
    head: 'abc123',
    branch: `refs/heads/${overrides.id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    hostId: 'local',
    ...overrides
  }
}

function makeLineage(
  child: Pick<Worktree, 'id' | 'instanceId'>,
  parent: Pick<Worktree, 'id' | 'instanceId'>
): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function makeFolderWorkspace(
  overrides: Partial<FolderWorkspace> & { id: string }
): FolderWorkspace {
  return {
    projectGroupId: 'pg-1',
    name: overrides.id,
    folderPath: `/tmp/${overrides.id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function makeSettings(startChildWorkspacesCollapsed: boolean) {
  return {
    ...getDefaultSettings('/tmp'),
    startChildWorkspacesCollapsed
  }
}

describe('installAutoCollapseChildWorkspacesObserver', () => {
  let uiSetSpy: ReturnType<typeof vi.fn>
  let bots: BotHomeOwner[]

  beforeEach(() => {
    bots = []
    uiSetSpy = vi.fn(() => Promise.resolve({}))
    vi.stubGlobal('window', { api: { ui: { set: uiSetSpy } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setupStore(options?: {
    startChildWorkspacesCollapsed?: boolean
    collapsedGroups?: string[]
    expandedLineageGroups?: string[]
    worktrees?: Worktree[]
    lineageById?: Record<string, WorktreeLineage>
    folderWorkspaces?: FolderWorkspace[]
    workspaceLineageByChildKey?: Readonly<Record<WorkspaceKey, WorkspaceLineage>>
  }) {
    const store = createUIStore()
    store.setState({
      settings: makeSettings(options?.startChildWorkspacesCollapsed ?? false),
      worktreesByRepo: { 'repo-1': options?.worktrees ?? [] },
      worktreeLineageById: options?.lineageById ?? {},
      workspaceLineageByChildKey: options?.workspaceLineageByChildKey ?? {},
      crossStoreLineageByStoreKey: {},
      ownLineageInstallationId: undefined,
      removedRuntimeEnvironmentIds: new Set(),
      folderWorkspaces: options?.folderWorkspaces ?? [],
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      activeWorkspaceKey: null
    })
    const unsubscribe = installAutoCollapseChildWorkspacesObserver(store, {
      readStatuses: () => EMPTY_STATUSES,
      readBotList: () => bots
    })
    store.getState().hydratePersistedUI(
      makePersistedUI({
        collapsedGroups: options?.collapsedGroups ?? [],
        expandedLineageGroups: options?.expandedLineageGroups ?? []
      }),
      'startup'
    )
    return { store, unsubscribe }
  }

  it('does not collapse new parents while startChildWorkspacesCollapsed is off', () => {
    const parent = makeWorktree({ id: 'parent-a', instanceId: 'inst-p' })
    const child = makeWorktree({ id: 'child-a', instanceId: 'inst-c' })
    const { store, unsubscribe } = setupStore({
      startChildWorkspacesCollapsed: false,
      worktrees: [parent]
    })

    store.setState({
      worktreesByRepo: { 'repo-1': [parent, child] },
      worktreeLineageById: { [child.id]: makeLineage(child, parent) }
    })

    expect([...store.getState().collapsedGroups]).toEqual([])
    unsubscribe()
  })

  it('keeps existing expanded parents open when enabled, collapses brand-new parents, and preserves manual expand across more children', () => {
    const existingParent = makeWorktree({ id: 'existing-parent', instanceId: 'inst-ep' })
    const existingChild = makeWorktree({ id: 'existing-child', instanceId: 'inst-ec' })
    const newParent = makeWorktree({ id: 'new-parent', instanceId: 'inst-np' })
    const firstChild = makeWorktree({ id: 'first-child', instanceId: 'inst-fc' })
    const secondChild = makeWorktree({ id: 'second-child', instanceId: 'inst-sc' })

    const { store, unsubscribe } = setupStore({
      startChildWorkspacesCollapsed: false,
      worktrees: [existingParent, existingChild, newParent],
      lineageById: { [existingChild.id]: makeLineage(existingChild, existingParent) }
    })

    store.setState({ settings: makeSettings(true) })
    expect([...store.getState().collapsedGroups]).toEqual([])
    expect([...store.getState().expandedLineageGroups]).toEqual(['lineage:local|existing-parent'])

    // Brand-new parent gets its first child while the user stays focused on the parent.
    store.setState({
      activeWorktreeId: newParent.id,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { 'repo-1': [existingParent, existingChild, newParent, firstChild] },
      worktreeLineageById: {
        [existingChild.id]: makeLineage(existingChild, existingParent),
        [firstChild.id]: makeLineage(firstChild, newParent)
      }
    })
    expect([...store.getState().collapsedGroups]).toEqual(['lineage:local|new-parent'])

    // User expands new-parent manually; a second child must keep it expanded.
    store.getState().toggleCollapsedGroup('lineage:local|new-parent')
    expect([...store.getState().collapsedGroups]).toEqual([])
    expect([...store.getState().expandedLineageGroups].sort()).toEqual([
      'lineage:local|existing-parent',
      'lineage:local|new-parent'
    ])

    store.setState({
      worktreesByRepo: {
        'repo-1': [existingParent, existingChild, newParent, firstChild, secondChild]
      },
      worktreeLineageById: {
        [existingChild.id]: makeLineage(existingChild, existingParent),
        [firstChild.id]: makeLineage(firstChild, newParent),
        [secondChild.id]: makeLineage(secondChild, newParent)
      }
    })
    expect([...store.getState().collapsedGroups]).toEqual([])

    // Manual re-collapse removes the expand override while preserving existing overrides.
    store.getState().toggleCollapsedGroup('lineage:local|new-parent')
    expect([...store.getState().collapsedGroups]).toEqual(['lineage:local|new-parent'])
    expect([...store.getState().expandedLineageGroups]).toEqual(['lineage:local|existing-parent'])

    unsubscribe()
  })

  it('collapses unseen remote parents arriving after restart while keeping persisted manual expands open', () => {
    const rememberedParent = makeWorktree({
      id: 'remote-open',
      instanceId: 'inst-ro',
      hostId: 'runtime:vps'
    })
    const rememberedChild = makeWorktree({
      id: 'remote-open-child',
      instanceId: 'inst-roc',
      hostId: 'runtime:vps'
    })
    const unseenParent = makeWorktree({
      id: 'remote-new',
      instanceId: 'inst-rn',
      hostId: 'runtime:vps'
    })
    const unseenChild = makeWorktree({
      id: 'remote-new-child',
      instanceId: 'inst-rnc',
      hostId: 'runtime:vps'
    })

    const { store, unsubscribe } = setupStore({
      startChildWorkspacesCollapsed: true,
      expandedLineageGroups: ['lineage:runtime:vps|remote-open']
    })

    // Remote host connects after startup and populates its worktrees + lineage.
    store.setState({
      worktreesByRepo: {
        'repo-1': [rememberedParent, rememberedChild, unseenParent, unseenChild]
      },
      worktreeLineageById: {
        [rememberedChild.id]: makeLineage(rememberedChild, rememberedParent),
        [unseenChild.id]: makeLineage(unseenChild, unseenParent)
      }
    })

    expect([...store.getState().collapsedGroups]).toEqual(['lineage:runtime:vps|remote-new'])
    expect([...store.getState().expandedLineageGroups]).toEqual(['lineage:runtime:vps|remote-open'])
    unsubscribe()
  })

  it('does not collapse a parent when its new child is active or pending reveal', () => {
    const parentActive = makeWorktree({ id: 'parent-active', instanceId: 'inst-pa' })
    const childActive = makeWorktree({ id: 'child-active', instanceId: 'inst-ca' })
    const parentReveal = makeWorktree({ id: 'parent-reveal', instanceId: 'inst-pr' })
    const childReveal = makeWorktree({ id: 'child-reveal', instanceId: 'inst-cr' })

    const { store, unsubscribe } = setupStore({
      startChildWorkspacesCollapsed: true,
      worktrees: [parentActive, parentReveal]
    })

    store.setState({
      activeWorktreeId: childActive.id,
      activeWorkspaceExecutionHostId: 'local',
      pendingRevealWorktree: {
        worktreeId: childReveal.id,
        executionHostId: 'local',
        behavior: 'auto',
        highlight: true
      },
      worktreesByRepo: { 'repo-1': [parentActive, childActive, parentReveal, childReveal] },
      worktreeLineageById: {
        [childActive.id]: makeLineage(childActive, parentActive),
        [childReveal.id]: makeLineage(childReveal, parentReveal)
      }
    })

    expect([...store.getState().collapsedGroups]).toEqual([])
    expect([...store.getState().expandedLineageGroups].sort()).toEqual([
      'lineage:local|parent-active',
      'lineage:local|parent-reveal'
    ])
    unsubscribe()
  })

  it('collapses regular folder workspace parents, skips bot homes, ignores archived children, and clears expand overrides when disabled', () => {
    const folder = makeFolderWorkspace({ id: 'fw-regular' })
    const botHome = makeFolderWorkspace({ id: 'fw-bot' })
    bots = [{ folderWorkspaceId: 'fw-bot', hostId: 'local' }]
    const folderChild = makeWorktree({ id: 'child-of-folder', instanceId: 'inst-cf' })
    const botChild = makeWorktree({ id: 'child-of-bot', instanceId: 'inst-cb' })
    const parentWithArchived = makeWorktree({ id: 'parent-archived', instanceId: 'inst-parch' })
    const archivedChild = makeWorktree({
      id: 'archived-child',
      instanceId: 'inst-arch',
      isArchived: true
    })

    const { store, unsubscribe } = setupStore({
      startChildWorkspacesCollapsed: true,
      folderWorkspaces: [folder, botHome],
      worktrees: [parentWithArchived]
    })

    const folderChildKey = worktreeWorkspaceKey(folderChild.id)
    const botChildKey = worktreeWorkspaceKey(botChild.id)
    const makeFolderLineage = (
      childKey: WorkspaceKey,
      childInstanceId: string,
      parentFolder: FolderWorkspace
    ): WorkspaceLineage => ({
      childWorkspaceKey: childKey,
      childInstanceId,
      parentWorkspaceKey: folderWorkspaceKey(parentFolder.id),
      parentInstanceId: parentFolder.id,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    const workspaceLineageByChildKey: Record<WorkspaceKey, WorkspaceLineage> = {
      [folderChildKey]: makeFolderLineage(folderChildKey, folderChild.instanceId!, folder),
      [botChildKey]: makeFolderLineage(botChildKey, botChild.instanceId!, botHome)
    }

    store.setState({
      worktreesByRepo: { 'repo-1': [parentWithArchived, archivedChild, folderChild, botChild] },
      worktreeLineageById: {
        [archivedChild.id]: makeLineage(archivedChild, parentWithArchived)
      },
      workspaceLineageByChildKey
    })

    expect([...store.getState().collapsedGroups]).toEqual(['lineage:local|folder:fw-regular'])

    // Expanding then disabling clears expandedLineageGroups while keeping collapsedGroups intact.
    store.getState().toggleCollapsedGroup('lineage:local|folder:fw-regular')
    expect([...store.getState().expandedLineageGroups]).toEqual(['lineage:local|folder:fw-regular'])

    store.setState({ settings: makeSettings(false) })
    expect([...store.getState().expandedLineageGroups]).toEqual([])
    unsubscribe()
  })
})
