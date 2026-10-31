import {
  workspacePresentationFor,
  workspaceReadState,
  workspaceSourceGroup,
  noteWorkspacePresentationChanges
} from '../../workspace-source-state'
import { editWorkspacePresentationDocuments } from '../../../../../shared/workspace-presentation-documents'
import { workspacePresentationKey } from '../../../../../shared/workspace-presentation'
import { reduceWorkspacePresentation } from '../../../../../shared/workspace-presentation-intent'
import type { Tab } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceSet, TabsSliceGet } from './tabs-slice-contract'
import { createTabsCreateActions } from './tabs-create-actions'

export function createPresentedTabsActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'createUnifiedTab' | 'createUnifiedTabInSplit'> {
  const raw = createTabsCreateActions(set, get, true)
  const createPresented: TabsSlice['createUnifiedTab'] = (worktreeId, contentType, init) => {
    const state = get()
    const saved = workspacePresentationFor(state, worktreeId)
    if (!saved) {
      return raw.createUnifiedTab(worktreeId, contentType, init)
    }
    let intended = workspaceReadState(state)
    const scratch: TabsSliceSet = (partial) => {
      intended = { ...intended, ...(typeof partial === 'function' ? partial(intended) : partial) }
    }
    const shown = createTabsCreateActions(scratch, () => intended, true).createUnifiedTab(
      saved.displayWorkspaceId,
      contentType,
      { ...init, recordInteraction: false }
    )
    const commit: TabsSliceSet = (partial) =>
      set((current) => {
        const patch = typeof partial === 'function' ? partial(current) : partial
        const currentSaved = workspacePresentationFor(current, worktreeId) ?? saved
        const key = workspacePresentationKey(currentSaved.owner, currentSaved.anchor)
        const document = reduceWorkspacePresentation(currentSaved, {
          type: 'layout',
          tabs: intended.unifiedTabsByWorktree[saved.displayWorkspaceId],
          groups: intended.groupsByWorktree[saved.displayWorkspaceId],
          layout: intended.layoutByWorktree[saved.displayWorkspaceId],
          activeGroupId: intended.activeGroupIdByWorktree[saved.displayWorkspaceId]
        })
        const documents = editWorkspacePresentationDocuments(
          current.workspacePresentations ?? {},
          key,
          document
        )
        noteWorkspacePresentationChanges(documents, [key])
        return { ...patch, workspacePresentations: documents }
      })
    createTabsCreateActions(commit, get, true).createUnifiedTab(worktreeId, contentType, {
      ...init,
      id: shown.id,
      entityId: shown.entityId,
      targetGroupId: workspaceSourceGroup(state, worktreeId, init?.targetGroupId),
      split: undefined,
      validatePlacement: undefined,
      afterTabId: (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
        (tab) => tab.id === init?.afterTabId
      )
        ? init?.afterTabId
        : undefined
    })
    return (
      workspaceReadState(get()).unifiedTabsByWorktree[saved.displayWorkspaceId]?.find(
        (tab) => tab.id === shown.id
      ) ?? shown
    )
  }
  return {
    createUnifiedTab: createPresented,
    createUnifiedTabInSplit: (worktreeId, contentType, target, init) => {
      if (!workspacePresentationFor(get(), worktreeId)) {
        return raw.createUnifiedTabInSplit(worktreeId, contentType, target, init)
      }
      return createPresented(worktreeId, contentType, { ...init, split: target })
    }
  }
}

/** Reduces a source creator's issued tab into its independent requested outer placement. */
export function presentCreatedWorkspaceTab(
  state: ReturnType<TabsSliceGet>,
  tab: Tab,
  init: Parameters<TabsSlice['createUnifiedTab']>[2]
) {
  const saved = workspacePresentationFor(state, tab.worktreeId)
  if (!saved) {
    return undefined
  }
  let intended = workspaceReadState(state)
  const scratch: TabsSliceSet = (partial) => {
    intended = { ...intended, ...(typeof partial === 'function' ? partial(intended) : partial) }
  }
  createTabsCreateActions(scratch, () => intended, true).createUnifiedTab(
    saved.displayWorkspaceId,
    tab.contentType,
    {
      ...init,
      id: tab.id,
      entityId: tab.entityId,
      label: tab.label,
      executionHostId: tab.executionHostId,
      recordInteraction: false
    }
  )
  const key = workspacePresentationKey(saved.owner, saved.anchor)
  const document = reduceWorkspacePresentation(saved, {
    type: 'layout',
    tabs: intended.unifiedTabsByWorktree[saved.displayWorkspaceId],
    groups: intended.groupsByWorktree[saved.displayWorkspaceId],
    layout: intended.layoutByWorktree[saved.displayWorkspaceId],
    activeGroupId: intended.activeGroupIdByWorktree[saved.displayWorkspaceId]
  })
  const documents = editWorkspacePresentationDocuments(
    state.workspacePresentations ?? {},
    key,
    document
  )
  noteWorkspacePresentationChanges(documents, [key])
  return documents
}
