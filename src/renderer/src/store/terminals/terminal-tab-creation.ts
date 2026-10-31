import {
  workspacePresentationFor,
  workspaceSourceGroup,
  workspaceReadState
} from '../workspace-source-state'
import { presentCreatedWorkspaceTab } from '../slices/tabs/tabs-presentation-creation'
import { clearWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  recordCreatedTerminalTabInLayoutOwner,
  terminalTabCreateCommand
} from './terminal-tab-create-through-layout-owner'
import { buildTerminalTabSourceAdmission } from './terminal-tab-source-admission'
import type { AppState } from '../types'
export function createTerminalTabCreationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet,
  subscribe: (listener: (state: AppState) => void) => () => void
): Pick<TerminalSlice, 'createTab'> {
  return {
    createTab: (worktreeId, targetGroupId, shellOverride, options) => {
      let tab!: TerminalTab
      const intent = { targetGroupId, split: options?.split, activate: options?.activate }
      const presented = workspacePresentationFor(get(), worktreeId)
      if (presented) {
        targetGroupId = workspaceSourceGroup(get(), worktreeId, targetGroupId)
        options = { ...options, split: undefined }
      }
      const split = options?.split
      const splitGroupId = split ? createBrowserUuid() : undefined
      set((current) => {
        const admitted = buildTerminalTabSourceAdmission(
          current,
          worktreeId,
          targetGroupId,
          shellOverride,
          options,
          split,
          splitGroupId
        )
        tab = admitted.tab
        const patch = admitted.patch
        const issued = patch.unifiedTabsByWorktree?.[worktreeId]?.find(
          (entry) => entry.entityId === tab.id && entry.contentType === 'terminal'
        )
        const documents =
          presented && issued ? presentCreatedWorkspaceTab(current, issued, intent) : undefined
        return documents ? { ...patch, workspacePresentations: documents } : patch
      })
      // Switch point: main writes the tab under these ids before any later command names it.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        recordCreatedTerminalTabInLayoutOwner(
          get(),
          terminalTabCreateCommand(workspaceReadState(get()), tab),
          {
            tab,
            store: { getState: get, setState: (patch) => set(patch), subscribe }
          }
        )
      }
      if (options?.initialPtyId) {
        // Why: a tab born with a live PTY (CLI/runtime create) wakes the workspace like any other bind.
        clearWorktreeSleepIntent(worktreeId)
      }
      const shouldRecordInteraction =
        options?.recordInteraction ?? (!options?.pendingActivationSpawn && !options?.initialPtyId)
      if (shouldRecordInteraction) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      if (splitGroupId) {
        get().recordFeatureInteraction?.('terminal-panes')
      }
      return tab
    }
  }
}
