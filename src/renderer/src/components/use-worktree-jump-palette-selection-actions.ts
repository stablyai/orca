import { useCallback } from 'react'
import { toast } from 'sonner'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator-tab-palette-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import type { BrowserPaletteSearchResult } from '@/lib/browser-palette-search'
import type { SimulatorPaletteSearchResult } from '@/lib/simulator-palette-search'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type { CmdJActionResult, CmdJSettingsResult } from '@/components/cmd-j/palette-results'
import type { CmdJProjectSearchResult } from '@/components/cmd-j/palette-project-results'
import { getUnavailableQuickActionMessage } from './use-worktree-jump-palette-quick-actions'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { PaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'

function getSettingsTargetFromSectionId(sectionId: string): {
  pane: SettingsNavTarget
  repoId: string | null
  sectionId?: string
} {
  if (sectionId.startsWith('repo-')) {
    return { pane: 'repo', repoId: sectionId.slice('repo-'.length) }
  }
  return { pane: sectionId as SettingsNavTarget, repoId: null }
}

type WorktreeJumpPaletteSelectionActionsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteLocalState &
  Pick<WorktreeJumpPaletteQuickActions, 'buildQuickActionContext'> &
  Pick<WorktreeJumpPaletteSelectionLifecycle, 'focusFallbackSurface' | 'requestBrowserFocus'>

export function useWorktreeJumpPaletteSelectionActions({
  closeModal,
  recordFeatureInteraction,
  skipRestoreFocusRef,
  setSelectedItemId,
  focusFallbackSurface,
  requestBrowserFocus,
  openSettingsTarget,
  openSettingsPage,
  buildQuickActionContext,
  revealSidebarRow,
  previousActiveTabTypeRef,
  previousBrowserPageIdRef,
  previousBrowserFocusTargetRef,
  previousWorktreeIdRef,
  previousFocusElementRef
}: WorktreeJumpPaletteSelectionActionsInput) {
  const handleSelectWorktree = useCallback(
    (worktree: Worktree) => {
      const current = useAppStore.getState().getKnownWorktreeById(worktree.id, worktree.hostId)
      if (!current) {
        toast.error(
          translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
        )
        return
      }
      const activation = activateAndRevealWorktree(
        worktree.id,
        worktree.hostId ? { executionHostId: worktree.hostId } : {}
      )
      recordFeatureInteraction('cmd-j-workspace-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      if (!queueWorkspaceActivationTerminalFocus(worktree.id, activation)) {
        focusFallbackSurface()
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [closeModal, focusFallbackSurface, recordFeatureInteraction]
  )
  const handleSelectBrowserPage = useCallback(
    (result: BrowserPaletteSearchResult) => {
      const activation = activateBrowserPagePaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason === 'missing-page'
            ? translate(
                'auto.components.WorktreeJumpPalette.d7d496a451',
                'Browser page no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
              )
        )
        return
      }
      recordFeatureInteraction('cmd-j-browser-page-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      requestBrowserFocus({ pageId: activation.pageId, target: activation.focusTarget })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [closeModal, recordFeatureInteraction, requestBrowserFocus]
  )
  const handleSelectSimulatorTab = useCallback(
    (result: SimulatorPaletteSearchResult) => {
      const activation = activateSimulatorTabPaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason === 'missing-tab'
            ? translate(
                'auto.components.WorktreeJumpPalette.7726ce9970',
                'Mobile emulator tab no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
              )
        )
        return
      }
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [closeModal]
  )
  const handleSelectWorkspaceTab = useCallback(
    (result: WorkspaceTabPaletteSearchResult) => {
      const activation = activateWorkspaceTabPaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason === 'missing-worktree'
            ? translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.workspaceTabMissing',
                'Tab no longer exists'
              )
        )
        return
      }
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [closeModal]
  )
  const handleSelectSettings = useCallback(
    (result: CmdJSettingsResult) => {
      const target = getSettingsTargetFromSectionId(result.sectionId)
      if (result.targetSectionId) {
        target.sectionId = result.targetSectionId
      }
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      openSettingsTarget(target)
      openSettingsPage()
      recordFeatureInteraction('cmd-j-settings-open')
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [closeModal, openSettingsPage, openSettingsTarget, recordFeatureInteraction]
  )
  const handleSelectQuickAction = useCallback(
    (action: CmdJActionResult) => {
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      const context = buildQuickActionContext()
      void action
        .run(context)
        .then((result) => {
          if (result.status === 'unavailable') {
            toast.error(getUnavailableQuickActionMessage(action.title, result.reason))
            return
          }
          if (action.id === 'create-workspace') {
            recordFeatureInteraction('cmd-j-create-workspace')
            return
          }
          recordFeatureInteraction('cmd-j-quick-action')
        })
        .catch((error: unknown) => {
          if (!action.id.startsWith('plugin:')) {
            throw error
          }
          toast.error(
            translate(
              'auto.components.WorktreeJumpPalette.pluginCommandFailed',
              'Could not run the plugin command.'
            )
          )
        })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [buildQuickActionContext, closeModal, recordFeatureInteraction]
  )
  const handleSelectProjectTarget = useCallback(
    (result: CmdJProjectSearchResult) => {
      skipRestoreFocusRef.current = true
      revealSidebarRow(result.rowKey, { behavior: 'smooth', highlight: true })
      recordFeatureInteraction('cmd-j')
      closeModal()
      setSelectedItemId('')
      if (previousActiveTabTypeRef.current === 'browser' && previousBrowserPageIdRef.current) {
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        focusFallbackSurface(previousFocusElementRef.current)
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    [
      closeModal,
      focusFallbackSurface,
      recordFeatureInteraction,
      requestBrowserFocus,
      revealSidebarRow
    ]
  )
  const handleSelectItem = useCallback(
    (item: PaletteItem) => {
      if (item.type === 'worktree') {
        handleSelectWorktree(item.worktree)
      } else if (item.type === 'project-target') {
        handleSelectProjectTarget(item.result)
      } else if (item.type === 'browser-page') {
        handleSelectBrowserPage(item.result)
      } else if (item.type === 'simulator-tab') {
        handleSelectSimulatorTab(item.result)
      } else if (item.type === 'workspace-tab') {
        handleSelectWorkspaceTab(item.result)
      } else if (item.type === 'settings') {
        handleSelectSettings(item.result)
      } else {
        handleSelectQuickAction(item.result)
      }
    },
    [
      handleSelectBrowserPage,
      handleSelectProjectTarget,
      handleSelectQuickAction,
      handleSelectSettings,
      handleSelectSimulatorTab,
      handleSelectWorkspaceTab,
      handleSelectWorktree
    ]
  )
  return { handleSelectItem }
}

export type WorktreeJumpPaletteSelectionActions = ReturnType<
  typeof useWorktreeJumpPaletteSelectionActions
>
