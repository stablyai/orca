import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { usePipelineManager } from './use-pipeline-manager'
import type { PipelineV2TemplateListItem } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import { PipelineTemplateEditor } from './PipelineTemplateEditor'
import { PipelineSaveRecovery } from './PipelineSaveRecovery'
import { PipelineLaunchPreview } from './PipelineLaunchPreview'
import type { PipelineDraftConfirmation } from './PipelineDraftActions'

type Manager = ReturnType<typeof usePipelineManager>
type Action = (callback: () => Promise<unknown>) => void
type Confirmation =
  | 'publish'
  | Extract<PipelineV2TemplateListItem, { kind: 'versions' }>
  | undefined

export function PipelineTemplateEditorPage({
  manager,
  workspacePath,
  action,
  onDraftAction
}: {
  manager: Manager
  workspacePath?: string
  action: Action
  onDraftAction: (value: PipelineDraftConfirmation) => void
}) {
  const t = useTranslate()
  const editor = manager.editor
  if (!editor) {
    return null
  }
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{editor.template.title}</h2>
        <p className="text-sm text-muted-foreground">
          {editor.pending
            ? t(
                'pipelines.saveUnconfirmedPlain',
                'The save result is unknown. Your text is preserved.'
              )
            : editor.dirty
              ? t('pipelines.unsaved', 'Unsaved changes')
              : t('pipelines.draftSaved', 'Draft saved')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={manager.busy || manager.hasPending || !editor.dirty}
          onClick={() => onDraftAction({ kind: 'reset' })}
        >
          {t('pipelines.resetChanges', 'Revert changes')}
        </Button>
        <Button
          variant="ghost"
          disabled={manager.busy || manager.hasPending}
          onClick={() =>
            onDraftAction({
              kind: 'delete',
              id: editor.draftId,
              revision: editor.revision,
              title: editor.template.title
            })
          }
        >
          {t('pipelines.deleteDraft', 'Delete draft')}
        </Button>
      </div>
      <PipelineTemplateEditor
        editor={editor}
        workspacePath={workspacePath}
        checks={manager.checks}
        onEdit={manager.edit}
        disabled={manager.busy || Boolean(manager.pendingDelete)}
      />
      {editor.saveError && (
        <PipelineSaveRecovery busy={manager.busy} onRecover={() => action(manager.recoverSave)} />
      )}
      <PipelineLaunchPreview preview={manager.launchPreview} stages={editor.template.stages} />
    </section>
  )
}

export function PipelineTemplateManagerActions({
  manager,
  editing,
  confirm,
  setConfirm,
  action,
  setNotice,
  onPublished,
  onClose,
  onShowRun
}: {
  manager: Manager
  editing: boolean
  confirm: Confirmation
  setConfirm: (value: Confirmation) => void
  action: Action
  setNotice: (value: string) => void
  onPublished?: () => void
  onClose: () => void
  onShowRun?: () => void
}) {
  const t = useTranslate()
  const editor = editing ? manager.editor : undefined
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t p-4">
        {onShowRun && (
          <Button variant="outline" onClick={onShowRun}>
            {t('pipelines.openRun', 'Open task run')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('pipelines.close', 'Close')}
        </Button>
        {editor && (
          <>
            <Button
              variant="outline"
              disabled={
                manager.busy ||
                editor.dirty ||
                Boolean(editor.pending) ||
                Boolean(manager.pendingDelete)
              }
              onClick={() =>
                action(async () => {
                  await manager.validate()
                  setNotice(t('pipelines.valid', 'The saved template is valid.'))
                })
              }
            >
              {t('pipelines.validate', 'Validate')}
            </Button>
            <Button
              variant="secondary"
              disabled={
                manager.busy ||
                Boolean(manager.pendingDelete) ||
                Boolean(editor.saveError) ||
                (!editor.dirty && !editor.pending)
              }
              onClick={() => action(manager.save)}
            >
              {editor.pending
                ? t('pipelines.checkSaveResult', 'Check save result')
                : t('pipelines.saveDraft', 'Save draft')}
            </Button>
            <Button
              disabled={
                manager.busy ||
                editor.dirty ||
                Boolean(editor.pending) ||
                Boolean(manager.pendingDelete)
              }
              onClick={() => setConfirm('publish')}
            >
              {t('pipelines.publish', 'Publish version')}
            </Button>
          </>
        )}
      </div>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(value) => {
          if (!value && !manager.busy) {
            setConfirm(undefined)
          }
        }}
      >
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>
              {confirm === 'publish'
                ? t('pipelines.publish', 'Publish version')
                : t('pipelines.changeAvailability', 'Change version availability')}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'publish'
                ? t(
                    'pipelines.publishMeaning',
                    'Publish this saved revision for new workspaces. Current runs keep their existing snapshot. Review the stages, models, checks and return limits before confirming.'
                  )
                : t(
                    'pipelines.disableMeaning',
                    'Changing availability affects new dispatches for this exact version. Running evidence is retained; enabling it does not accept decisions or resume runs.'
                  )}
            </DialogDescription>
          </DialogHeader>
          {manager.error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {manager.error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={manager.busy} onClick={() => setConfirm(undefined)}>
              {t('pipelines.cancel', 'Cancel')}
            </Button>
            <Button
              disabled={manager.busy}
              onClick={() =>
                action(async () => {
                  if (confirm === 'publish') {
                    await manager.publish()
                    setNotice(t('pipelines.published', 'Version published.'))
                  } else if (confirm) {
                    await manager.toggle(confirm)
                  }
                  onPublished?.()
                  setConfirm(undefined)
                })
              }
            >
              {t('pipelines.confirm', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
