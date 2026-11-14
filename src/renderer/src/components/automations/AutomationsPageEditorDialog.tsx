import React from 'react'
import { AutomationEditorDialog } from './authoring/AutomationEditorDialog'
import { getAutomationAuthorityTarget } from './hosts/automation-host-client'
import type { AutomationsPageController } from './use-automations-page-controller'

/** Create/edit dialog wiring; the dialog itself owns its layout and validation. */
export function AutomationsPageEditorDialog({
  controller
}: {
  controller: AutomationsPageController
}): React.JSX.Element {
  const {
    store,
    local,
    list,
    destination,
    destinationForm,
    setup,
    presentation,
    pageRefresh,
    draftEffects,
    editorActions,
    saveAutomation
  } = controller
  const { projectHostSetups, repoMap, settings } = store
  const {
    createOpen,
    editingAutomationId,
    isSaving,
    automationYamlHooksByRepoKey,
    draft,
    setCreateOpen,
    editorNotice,
    setEditorNotice,
    editorNoticeHost,
    setEditorNoticeHost
  } = local
  const { hostCatalog } = list
  return (
    <AutomationEditorDialog
      open={createOpen}
      isEditing={editingAutomationId !== null}
      isSaving={isSaving}
      canSave={presentation.canSaveDraft}
      createDestination={destination.createDestination.control}
      editDestination={destinationForm.editDestinationControl}
      launchAuthority={destinationForm.editorSaveAuthority}
      notice={editorNotice}
      onNoticeRecover={(action) => {
        const host = editorNoticeHost ?? destination.editorRecoveryHost
        setEditorNotice(null)
        setEditorNoticeHost(null)
        hostCatalog.recover(action, host)
        if (action === 'retry') {
          void pageRefresh.refresh()
        }
      }}
      onNoticeDismiss={() => {
        setEditorNotice(null)
        setEditorNoticeHost(null)
      }}
      repos={destinationForm.dialogRepos}
      projectHostSetups={projectHostSetups}
      automationYamlHooksByRepoKey={automationYamlHooksByRepoKey}
      getAutomationHooksCacheKey={setup.getAutomationHooksCacheKey}
      repoMap={repoMap}
      worktrees={destinationForm.dialogWorktrees}
      settings={settings}
      draft={draft}
      onProjectChange={editorActions.handleProjectChange}
      getRepoHostLabel={presentation.getAutomationRepoHostLabel}
      allowAddProject={
        editingAutomationId !== null
          ? destinationForm.editHostResolution.status === 'ready'
            ? getAutomationAuthorityTarget(destinationForm.editHostResolution.authority).kind ===
              'local'
            : destinationForm.automationDialogTarget.kind === 'local'
          : destinationForm.automationDialogTarget.kind === 'local'
      }
      onOpenChange={(open) => {
        setCreateOpen(open)
        if (!open) {
          setEditorNotice(null)
          setEditorNoticeHost(null)
        }
      }}
      onDraftChange={editorActions.handleDraftChange}
      onSetupDecisionTouched={setup.markSetupDecisionTouched}
      onApplyTemplate={draftEffects.applyTemplateToDraft}
      onSave={() => void saveAutomation()}
    />
  )
}
