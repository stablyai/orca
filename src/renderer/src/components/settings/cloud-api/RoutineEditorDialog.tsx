import { useEffect, useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiInstallation,
  CloudApiProject,
  CloudApiResult,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { cloudApiErrorCopy } from './cloud-api-copy'
import { CloudApiErrorNotice, FormField } from './cloud-api-parts'
import {
  RoutineGithubFields,
  RoutineScheduleFields,
  RoutineTriggerKindControl
} from './RoutineTriggerFields'
import { RoutineAgentSection, routineFieldError as fieldError } from './RoutineAgentSection'
import { GithubAppHint, WebhookTriggerInfo, WebhookUrlStep } from './RoutineWebhookParts'
import {
  emptyRoutineDraft,
  routineDraftFromRoutine,
  routinePatchFromInput,
  withCurrentProject,
  validateRoutineDraft,
  type RoutineDraft,
  type RoutineDraftField
} from './routine-draft'

export type RoutineEditorDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null creates a new routine. */
  routine: Routine | null
  projects: readonly CloudApiProject[]
  /** The project list could not be loaded (not the same as having none). */
  projectsFailed?: boolean
  installations: readonly CloudApiInstallation[] | null
  localTimezone: string
  onCreate: (input: RoutineInput) => Promise<CloudApiResult<RoutineCreated>>
  onUpdate: (id: string, patch: RoutinePatch) => Promise<CloudApiResult<{ routine: Routine }>>
  onRotateWebhook: (routine: Routine) => Promise<CloudApiResult<{ url: string }>>
  /** Fixtures: preset form values / open on the one-time webhook URL. */
  initialDraft?: Partial<RoutineDraft>
  initialWebhookUrl?: string
}

export function RoutineEditorDialog(props: RoutineEditorDialogProps): React.JSX.Element {
  const [webhookUrl, setWebhookUrl] = useState<string | null>(props.initialWebhookUrl ?? null)
  const [busy, setBusy] = useState(false)
  // A save or rotate in flight keeps the dialog open: its result (maybe a one-time URL) must land
  // in front of the user, never in a closed dialog.
  const change = (open: boolean): void => {
    if (!open && busy) {
      return
    }
    if (!open) {
      setWebhookUrl(null)
    }
    props.onOpenChange(open)
  }
  return (
    <Dialog open={props.open} onOpenChange={change}>
      <DialogContent
        className="sm:max-w-[640px]"
        scrollable
        // Never lose a half-written routine to a stray click; while the one-time webhook URL is
        // showing, only its footer button may close the dialog.
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={!webhookUrl}
        onEscapeKeyDown={webhookUrl ? (event) => event.preventDefault() : undefined}
      >
        {webhookUrl ? (
          <WebhookUrlStep url={webhookUrl} onDone={() => change(false)} />
        ) : (
          <EditorForm
            // A fresh form per routine (and per open) so stale edits never leak between them.
            key={props.routine?.id ?? 'new'}
            {...props}
            onCancel={() => change(false)}
            onBusyChange={setBusy}
            onSaved={(url) => (url ? setWebhookUrl(url) : change(false))}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditorForm({
  routine,
  projects,
  projectsFailed = false,
  installations,
  localTimezone,
  onCreate,
  onUpdate,
  onRotateWebhook,
  initialDraft,
  onCancel,
  onSaved,
  onBusyChange
}: RoutineEditorDialogProps & {
  onBusyChange: (busy: boolean) => void
  onCancel: () => void
  onSaved: (webhookUrl: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const [draft, setDraft] = useState<RoutineDraft>(() => ({
    ...(routine
      ? routineDraftFromRoutine(routine, localTimezone)
      : emptyRoutineDraft(localTimezone)),
    ...(!routine && projects.length > 0
      ? { source: 'project' as const, projectId: projects[0]!.id }
      : {}),
    ...initialDraft
  }))
  const [errors, setErrors] = useState<Partial<Record<RoutineDraftField, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [rotated, setRotated] = useState<string | null>(null)
  const [rotating, setRotating] = useState<'idle' | 'confirm' | 'busy'>('idle')

  const projectOptions = withCurrentProject(
    projects,
    draft.projectId,
    t('auto.components.settings.cloudRoutines.editor.currentProject', 'Current project')
  )
  const busy = submitting || rotating === 'busy'
  useEffect(() => {
    onBusyChange(busy)
  }, [busy, onBusyChange])

  const update = (patch: Partial<RoutineDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    // Clear a field's error as soon as it is edited.
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(patch)) {
        delete next[key as RoutineDraftField]
      }
      if ('projectId' in patch) {
        delete next.source
      }
      return next
    })
  }
  const err = (field: RoutineDraftField): string | null => fieldError(errors[field], field, t)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const validation = validateRoutineDraft(draft)
    if (!validation.ok) {
      setErrors(validation.errors)
      // Move focus to the first invalid control so keyboard users land on the problem.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-routine-editor] [aria-invalid="true"]')?.focus()
      })
      return
    }
    setSubmitting(true)
    setFailure(null)
    if (routine) {
      const patch = routinePatchFromInput(routine, validation.input)
      if (Object.keys(patch).length === 0) {
        setSubmitting(false)
        onSaved(null)
        return
      }
      const result = await onUpdate(routine.id, patch)
      setSubmitting(false)
      if (!result.ok) {
        setFailure(cloudApiErrorCopy(result.error, t, result))
        return
      }
      onSaved(null)
      return
    }
    const result = await onCreate(validation.input)
    setSubmitting(false)
    if (!result.ok) {
      setFailure(cloudApiErrorCopy(result.error, t, result))
      return
    }
    onSaved(result.data.webhookUrl ?? null)
  }

  const rotate = async (): Promise<void> => {
    if (!routine) {
      return
    }
    setRotating('busy')
    const result = await onRotateWebhook(routine)
    setRotating('idle')
    if (result.ok) {
      setRotated(result.data.url)
    } else {
      setFailure(cloudApiErrorCopy(result.error, t, result))
    }
  }

  return (
    <form
      data-routine-editor=""
      onSubmit={(event) => void submit(event)}
      className="grid gap-6"
      noValidate
    >
      <DialogHeader>
        <DialogTitle>
          {routine
            ? t('auto.components.settings.cloudRoutines.editor.editTitle', 'Edit routine')
            : t('auto.components.settings.cloudRoutines.editor.createTitle', 'New routine')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.settings.cloudRoutines.editor.description',
            'A routine starts a fresh cloud workspace, runs an agent with your prompt, and can post what it did back to GitHub.'
          )}
        </DialogDescription>
      </DialogHeader>

      <FormField
        id={`${ids}-name`}
        label={t('auto.components.settings.cloudRoutines.editor.name', 'Name')}
        error={err('name')}
      >
        <Input
          id={`${ids}-name`}
          autoFocus
          value={draft.name}
          maxLength={100}
          placeholder={t(
            'auto.components.settings.cloudRoutines.editor.namePlaceholder',
            'e.g. Triage new issues'
          )}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `${ids}-name-error` : undefined}
          onChange={(event) => update({ name: event.target.value })}
        />
      </FormField>

      <section className="grid gap-3" aria-labelledby={`${ids}-where`}>
        <h3 id={`${ids}-where`} className="text-sm font-semibold">
          {t('auto.components.settings.cloudRoutines.editor.where', 'Where it runs')}
        </h3>
        <div>
          <SettingsSegmentedControl<'project' | 'repo'>
            size="sm"
            equalWidth
            value={draft.source}
            onChange={(source) => update({ source })}
            ariaLabelledBy={`${ids}-where`}
            options={[
              {
                value: 'project',
                label: t('auto.components.settings.cloudRoutines.editor.project', 'Project')
              },
              {
                value: 'repo',
                label: t('auto.components.settings.cloudRoutines.editor.repo', 'Repository URL')
              }
            ]}
          />
        </div>
        {draft.source === 'project' ? (
          <FormField
            id={`${ids}-project`}
            label={t('auto.components.settings.cloudRoutines.editor.projectLabel', 'Project')}
            error={err('source')}
            hint={
              projectsFailed
                ? t(
                    'auto.components.settings.cloudRoutines.editor.projectsFailed',
                    'Could not load your projects. Close and reopen to try again, or use a repository URL.'
                  )
                : projects.length === 0
                  ? t(
                      'auto.components.settings.cloudRoutines.editor.noProjects',
                      'No Orca Cloud projects yet. Use a repository URL instead.'
                    )
                  : undefined
            }
          >
            <Select
              value={draft.projectId}
              onValueChange={(projectId) => update({ projectId })}
              disabled={projectOptions.length === 0}
            >
              <SelectTrigger
                id={`${ids}-project`}
                className="w-full"
                aria-invalid={Boolean(errors.source)}
              >
                <SelectValue
                  placeholder={t(
                    'auto.components.settings.cloudRoutines.editor.pickProject',
                    'Choose a project'
                  )}
                />
              </SelectTrigger>
              <SelectContent position="popper">
                {projectOptions.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                    {project.repo ? (
                      <span className="ml-1.5 text-muted-foreground">
                        {project.repo.url.replace(/^https:\/\/(www\.)?/, '')}
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <FormField
              id={`${ids}-repo`}
              label={t('auto.components.settings.cloudRoutines.editor.repoLabel', 'Repository')}
              error={err('repoUrl')}
            >
              <Input
                id={`${ids}-repo`}
                value={draft.repoUrl}
                inputMode="url"
                spellCheck={false}
                placeholder="https://github.com/acme/api"
                aria-invalid={Boolean(errors.repoUrl)}
                aria-describedby={errors.repoUrl ? `${ids}-repo-error` : undefined}
                onChange={(event) => update({ repoUrl: event.target.value })}
              />
            </FormField>
            <FormField
              id={`${ids}-ref`}
              label={t('auto.components.settings.cloudRoutines.editor.ref', 'Branch')}
            >
              <Input
                id={`${ids}-ref`}
                value={draft.repoRef}
                spellCheck={false}
                placeholder={t(
                  'auto.components.settings.cloudRoutines.editor.refPlaceholder',
                  'default'
                )}
                onChange={(event) => update({ repoRef: event.target.value })}
              />
            </FormField>
          </div>
        )}
        <GithubAppHint installations={installations} />
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids}-when`}>
        <h3 id={`${ids}-when`} className="text-sm font-semibold">
          {t('auto.components.settings.cloudRoutines.editor.when', 'When it runs')}
        </h3>
        <RoutineTriggerKindControl
          value={draft.triggerKind}
          onChange={(triggerKind) => update({ triggerKind })}
          labelledBy={`${ids}-when`}
        />
        <div className="rounded-lg border border-border/70 bg-muted/15 p-3.5">
          {draft.triggerKind === 'schedule' ? (
            <RoutineScheduleFields draft={draft} update={update} cronError={err('customCron')} />
          ) : draft.triggerKind === 'github' ? (
            <RoutineGithubFields draft={draft} update={update} eventsError={err('githubEvents')} />
          ) : (
            <WebhookTriggerInfo
              routine={routine}
              rotated={rotated}
              rotating={rotating}
              onAskRotate={() => setRotating('confirm')}
              onCancelRotate={() => setRotating('idle')}
              onRotate={() => void rotate()}
            />
          )}
        </div>
      </section>

      <RoutineAgentSection draft={draft} update={update} errors={errors} />

      {failure ? <CloudApiErrorNotice message={failure} /> : null}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
          {routine
            ? t('auto.components.settings.cloudRoutines.editor.save', 'Save changes')
            : t('auto.components.settings.cloudRoutines.editor.create', 'Create routine')}
        </Button>
      </DialogFooter>
    </form>
  )
}
