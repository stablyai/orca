import { useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { PipelineTemplateStarters } from './PipelineTemplateStarters'
import { PipelineTemplateLibrary } from './PipelineTemplateLibrary'
import { PipelineLaunchPreview } from './PipelineLaunchPreview'
import { usePipelineManager } from './use-pipeline-manager'
import type { PipelineV2TemplateListItem } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import type { PipelineWorkspace } from './use-pipeline-workspace'
import { PipelineRunSheet } from './PipelineRunSheet'
import { PipelineOwnerRequests } from './PipelineOwnerRequests'
import { PipelineTemplatePreview } from './PipelineTemplatePreview'
import { PipelineRetainedInputs } from './PipelineRetainedInputs'
import { PipelineTerminology } from './PipelineTerminology'
import { PipelineDraftActions, type PipelineDraftConfirmation } from './PipelineDraftActions'
import {
  PipelineTemplateEditorPage,
  PipelineTemplateManagerActions
} from './PipelineTemplateEditorPage'

type View = 'library' | 'create' | 'editor' | 'preview' | 'requests' | 'recovery'
type Version = Extract<PipelineV2TemplateListItem, { kind: 'versions' }>

function PipelineTemplateManagerSheet({
  projectId,
  workspacePath,
  open,
  onOpenChange,
  onPublished,
  onShowRun
}: {
  projectId: string
  workspacePath?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPublished?: () => void
  onShowRun?: () => void
}) {
  const t = useTranslate()
  const manager = usePipelineManager(projectId, open)
  const [view, setView] = useState<View>('library')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Version>()
  const [confirm, setConfirm] = useState<'publish' | Version>()
  const [notice, setNotice] = useState('')
  const [draftConfirmation, setDraftConfirmation] = useState<PipelineDraftConfirmation>()
  const action = (callback: () => Promise<unknown>, next?: View) => {
    setNotice('')
    void manager.run(async () => {
      await callback()
      if (next) {
        setView(next)
      }
    })
  }
  const section = ['create', 'editor', 'preview'].includes(view) ? 'library' : view
  const items = manager.items.filter((item) =>
    item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent motion="respectPreference" className="w-full sm:max-w-5xl">
        <div className="shrink-0 border-b pr-8">
          <SheetHeader>
            <SheetTitle>{t('pipelines.manager', 'Pipeline templates')}</SheetTitle>
            <SheetDescription>
              {t(
                'pipelines.settingsDescription',
                'Configure reusable workflows. Follow each task in its Pipeline run tab.'
              )}
            </SheetDescription>
            <nav
              aria-label={t('pipelines.pipelineSections', 'Pipeline sections')}
              className="flex flex-wrap gap-1"
            >
              <Button
                variant={section === 'library' ? 'secondary' : 'ghost'}
                aria-current={section === 'library' ? 'page' : undefined}
                onClick={() => setView('library')}
              >
                {t('pipelines.templates', 'Templates')}
              </Button>
              <Button
                variant={section === 'requests' ? 'secondary' : 'ghost'}
                aria-current={section === 'requests' ? 'page' : undefined}
                onClick={() => setView('requests')}
              >
                {t('pipelines.decisionsInbox', 'Your decisions')}
              </Button>
              <Button
                variant={section === 'recovery' ? 'secondary' : 'ghost'}
                aria-current={section === 'recovery' ? 'page' : undefined}
                onClick={() => setView('recovery')}
              >
                {t('pipelines.recovery', 'Recovery')}
              </Button>
            </nav>
          </SheetHeader>
        </div>
        <div key={view} className="min-h-0 flex-1 space-y-5 overflow-y-auto scrollbar-sleek p-5">
          {manager.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 whitespace-pre-wrap break-words text-sm text-destructive"
            >
              {manager.error}
            </p>
          )}
          {manager.busy && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('pipelines.loadingTemplate', 'Loading template or saving changes…')}
            </p>
          )}
          {manager.pendingDelete && (
            <div className="space-y-2 rounded-md border border-status-warning-border bg-status-warning-background p-3 text-sm text-status-warning">
              <p>
                {t(
                  'pipelines.deleteUnconfirmed',
                  'The deletion result is unknown. Check the result before changing this draft.'
                )}
              </p>
              <Button
                variant="outline"
                disabled={manager.busy}
                onClick={() =>
                  action(async () => {
                    await manager.remove(
                      manager.pendingDelete!.draftId,
                      manager.pendingDelete!.expectedRevision
                    )
                    setView('library')
                  })
                }
              >
                {t('pipelines.checkDeleteResult', 'Check deletion result')}
              </Button>
            </div>
          )}
          {notice && (
            <p
              role="status"
              className="rounded-md border border-status-success-border bg-status-success-background p-3 text-sm text-status-success"
            >
              {notice}
            </p>
          )}
          {view === 'library' && (
            <>
              {manager.editor && (manager.editor.dirty || manager.editor.pending) && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-warning-border bg-status-warning-background p-3">
                  <p className="min-w-0 break-words text-sm">
                    {t('pipelines.unfinishedDraft', 'Unfinished draft: {{title}}', {
                      title: manager.editor.template.title
                    })}
                  </p>
                  <Button
                    variant="outline"
                    disabled={manager.busy}
                    onClick={() => setView('editor')}
                  >
                    {t('pipelines.continueEditing', 'Continue editing')}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {t('pipelines.library', 'Template library')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(
                      'pipelines.libraryPurpose',
                      'A template describes stages and possible transitions. It is not a running task.'
                    )}
                  </p>
                </div>
                <Button disabled={manager.busy} onClick={() => setView('create')}>
                  <Plus />
                  {t('pipelines.createTemplate', 'Create template')}
                </Button>
              </div>
              <Input
                aria-label={t('pipelines.findTemplate', 'Find a template')}
                placeholder={t('pipelines.findTemplate', 'Find a template')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {(['drafts', 'versions'] as const).map((kind) => (
                <section key={kind} className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    {kind === 'drafts'
                      ? t('pipelines.drafts', 'Drafts')
                      : t('pipelines.publishedTemplates', 'Published templates')}
                  </h3>
                  <PipelineTemplateLibrary
                    items={items.filter((item) => item.kind === kind)}
                    busy={manager.busy}
                    onOpen={(item) => {
                      if (item.kind === 'versions') {
                        setSelected(item)
                      }
                      action(
                        () => manager.open(item),
                        item.kind === 'drafts' ? 'editor' : 'preview'
                      )
                    }}
                    onCopy={(item) =>
                      action(
                        () => manager.create({ kind: 'copy', selection: item.selection }),
                        'editor'
                      )
                    }
                    onToggle={setConfirm}
                    onDelete={(item) =>
                      setDraftConfirmation({
                        kind: 'delete',
                        id: item.id,
                        revision: item.revision,
                        title: item.title
                      })
                    }
                  />
                </section>
              ))}
              {manager.hasMore && (
                <Button
                  variant="outline"
                  disabled={manager.busy}
                  onClick={() => action(() => manager.refresh(true))}
                >
                  {t('pipelines.loadMoreTemplates', 'Load more templates')}
                </Button>
              )}
            </>
          )}
          {view === 'library' && <PipelineTerminology />}
          {['create', 'editor', 'preview'].includes(view) && (
            <Button variant="ghost" disabled={manager.busy} onClick={() => setView('library')}>
              <ArrowLeft />
              {t('pipelines.backToTemplates', 'Back to templates')}
            </Button>
          )}
          {view === 'create' && (
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {t('pipelines.createTemplate', 'Create template')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    'pipelines.chooseStartingPoint',
                    'Choose a starting point, then edit its stages and transitions.'
                  )}
                </p>
              </div>
              <PipelineTemplateStarters
                disabled={manager.busy || !manager.runtimeId}
                onCustom={() => action(async () => manager.createCustom(), 'editor')}
                onCreate={(source) => action(() => manager.create(source), 'editor')}
              />
            </section>
          )}
          {view === 'preview' && manager.preview && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">
                  {t('pipelines.templateOverview', 'Template overview')}
                </h2>
                {selected && (
                  <Button
                    disabled={manager.busy}
                    onClick={() =>
                      action(
                        () => manager.create({ kind: 'copy', selection: selected.selection }),
                        'editor'
                      )
                    }
                  >
                    {t('pipelines.editCopy', 'Edit a copy')}
                  </Button>
                )}
              </div>
              <PipelineTemplatePreview template={manager.preview} />
              <PipelineLaunchPreview
                preview={manager.launchPreview}
                stages={manager.preview.stages}
              />
            </>
          )}
          {view === 'editor' && (
            <PipelineTemplateEditorPage
              manager={manager}
              workspacePath={workspacePath}
              action={action}
              onDraftAction={setDraftConfirmation}
            />
          )}
          {open && view === 'requests' && (
            <PipelineOwnerRequests
              projectId={projectId}
              onResolved={() => {
                void manager.refresh()
              }}
            />
          )}
          {view === 'recovery' && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">{t('pipelines.recovery', 'Recovery')}</h2>
              <p className="text-sm">
                {t(
                  'pipelines.recoveryPurpose',
                  'Recover text from unfinished edits or check an action whose result is unknown.'
                )}
              </p>
              <PipelineRetainedInputs />
            </section>
          )}
        </div>
        <PipelineTemplateManagerActions
          manager={manager}
          editing={view === 'editor'}
          confirm={confirm}
          setConfirm={setConfirm}
          action={action}
          setNotice={setNotice}
          onPublished={onPublished}
          onClose={() => onOpenChange(false)}
          onShowRun={view === 'library' ? onShowRun : undefined}
        />
        <PipelineDraftActions
          manager={manager}
          confirmation={draftConfirmation}
          setConfirmation={setDraftConfirmation}
          onDeleted={() => {
            setView('library')
            setNotice(t('pipelines.draftDeleted', 'Draft deleted.'))
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

export function PipelineManagerSheet(
  props: Parameters<typeof PipelineTemplateManagerSheet>[0] & {
    workspace?: PipelineWorkspace
    initialView?: 'library' | 'run'
    onShowTemplates?: () => void
  }
) {
  return props.workspace && props.initialView === 'run' ? (
    <PipelineRunSheet
      workspace={props.workspace}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onManage={props.onShowTemplates}
    />
  ) : (
    <PipelineTemplateManagerSheet key={props.projectId} {...props} />
  )
}
