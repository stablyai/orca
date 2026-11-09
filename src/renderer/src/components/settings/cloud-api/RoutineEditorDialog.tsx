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
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiInstallation,
  CloudApiProject,
  CloudApiResult,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch,
  RoutineUpdated
} from '../../../../../shared/cloud-api/cloud-api-types'
import { cloudApiErrorCopy } from './cloud-api-copy'
import { CloudApiErrorNotice, FormField } from './cloud-api-parts'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import {
  RoutineGithubFields,
  RoutineScheduleFields,
  RoutineTriggerKindControl
} from './RoutineTriggerFields'
import { RoutineSourceSection } from './RoutineSourceSection'
import { RoutineAgentSection, routineFieldError as fieldError } from './RoutineAgentSection'
import { WebhookTriggerInfo, WebhookUrlStep } from './RoutineWebhookParts'
import {
  emptyRoutineDraft,
  isRoutineDraftField,
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
  onUpdate: (id: string, patch: RoutinePatch) => Promise<CloudApiResult<RoutineUpdated>>
  onRotateWebhook: (routine: Routine) => Promise<CloudApiResult<{ url: string }>>
  /** Fixtures: preset form values / open on the one-time webhook URL. */
  initialDraft?: Partial<RoutineDraft>
  initialWebhookUrl?: string
}

export function RoutineEditorDialog(props: RoutineEditorDialogProps): React.JSX.Element {
  const t = useTranslate()
  const [webhook, setWebhook] = useState<{ url: string; rotated: boolean } | null>(
    props.initialWebhookUrl ? { url: props.initialWebhookUrl, rotated: false } : null
  )
  const webhookUrl = webhook?.url ?? null
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const close = (): void => {
    setWebhook(null)
    setDirty(false)
    props.onOpenChange(false)
  }
  // A save or rotate in flight keeps the dialog open: its result (maybe a one-time URL) must land
  // in front of the user, never in a closed dialog. Unsaved edits ask before they are thrown away.
  const change = (open: boolean): void => {
    if (open) {
      props.onOpenChange(true)
      return
    }
    if (busy) {
      return
    }
    if (dirty && !webhookUrl) {
      setConfirmDiscard(true)
      return
    }
    close()
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
        onEscapeKeyDown={(event) => {
          if (webhookUrl || busy || dirty) {
            event.preventDefault()
            if (dirty && !webhookUrl && !busy) {
              setConfirmDiscard(true)
            }
          }
        }}
      >
        {webhook ? (
          <WebhookUrlStep url={webhook.url} rotated={webhook.rotated} onDone={close} />
        ) : (
          <EditorForm
            // A fresh form per routine (and per open) so stale edits never leak between them.
            key={props.routine?.id ?? 'new'}
            {...props}
            onCancel={() => change(false)}
            onBusyChange={setBusy}
            onDirtyChange={setDirty}
            onRotated={(url) => setWebhook({ url, rotated: true })}
            onSaved={(url) => (url ? setWebhook({ url, rotated: false }) : close())}
          />
        )}
      </DialogContent>
      <CloudConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t('auto.components.settings.cloudRoutines.editor.discardTitle', 'Discard changes?')}
        description={
          <p>
            {t(
              'auto.components.settings.cloudRoutines.editor.discardBody',
              'Your edits to this routine have not been saved.'
            )}
          </p>
        }
        confirmLabel={t('auto.components.settings.cloudRoutines.editor.discard', 'Discard')}
        onConfirm={async () => {
          close()
          return null
        }}
      />
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
  onBusyChange,
  onDirtyChange,
  onRotated
}: RoutineEditorDialogProps & {
  onBusyChange: (busy: boolean) => void
  onDirtyChange: (dirty: boolean) => void
  onRotated: (url: string) => void
  onCancel: () => void
  onSaved: (webhookUrl: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const [initial] = useState<RoutineDraft>(() => ({
    ...(routine
      ? routineDraftFromRoutine(routine, localTimezone)
      : emptyRoutineDraft(localTimezone)),
    ...(!routine && projects.length > 0
      ? { source: 'project' as const, projectId: projects[0]!.id }
      : {}),
    ...initialDraft
  }))
  const [draft, setDraft] = useState<RoutineDraft>(initial)
  const [errors, setErrors] = useState<Partial<Record<RoutineDraftField, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const update = (patch: Partial<RoutineDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    // Clear a field's error as soon as it is edited.
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(patch)) {
        if (isRoutineDraftField(key)) {
          delete next[key]
        }
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
    if (submitting) {
      return
    }
    const validation = validateRoutineDraft(draft)
    if (!validation.ok) {
      setErrors(validation.errors)
      // Move focus to the first invalid control so keyboard users land on the problem.
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            '[data-routine-editor] :is(input, textarea, button)[aria-invalid="true"]'
          )
          ?.focus()
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
      onSaved(result.data.webhookUrl ?? null)
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
      // The new URL is shown once, on the same guarded step as a new routine's URL.
      onRotated(result.data.url)
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

      <RoutineSourceSection
        draft={draft}
        update={update}
        errors={errors}
        projects={projects}
        projectOptions={projectOptions}
        projectsFailed={projectsFailed}
        installations={installations}
      />

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
              rotating={rotating}
              dirty={dirty}
              onAskRotate={() => setRotating('confirm')}
              onCancelRotate={() => setRotating('idle')}
              onRotate={() => void rotate()}
            />
          )}
        </div>
      </section>

      <RoutineAgentSection draft={draft} update={update} errors={errors} />

      {failure ? <CloudApiErrorNotice message={failure} /> : null}

      {/* Sticky so Save stays in reach however long the form scrolls. */}
      <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 border-t border-border bg-dialog-surface px-6 py-3">
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={submitting ? undefined : onCancel}
            aria-disabled={submitting}
          >
            {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" aria-disabled={submitting} aria-busy={submitting}>
            {submitting ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
            {routine
              ? t('auto.components.settings.cloudRoutines.editor.save', 'Save changes')
              : t('auto.components.settings.cloudRoutines.editor.create', 'Create routine')}
          </Button>
        </DialogFooter>
      </div>
    </form>
  )
}
