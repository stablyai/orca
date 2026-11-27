import { useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import type { ItsaplanProjectMetadata } from '../../../../../../shared/itsaplan/itsaplan-types'

const UNASSIGNED = '__unassigned__'

function defaultColumnId(metadata: ItsaplanProjectMetadata | undefined): number | null {
  const columns = [...(metadata?.columns ?? [])].sort((a, b) => a.position - b.position)
  return (columns.find((column) => column.stateType === 'unstarted') ?? columns[0])?.id ?? null
}

function ItsaplanIssueForm({
  projectRef,
  metadata,
  submitShortcutLabel,
  onCancel,
  onCreated
}: {
  projectRef: string
  metadata: ItsaplanProjectMetadata | undefined
  submitShortcutLabel: string
  onCancel: () => void
  onCreated: TaskPageComposerActionsModel['openItsaplanDetailPage']
}): React.JSX.Element {
  const t = useTranslate()
  const createItsaplanIssue = useAppStore((s) => s.createItsaplanIssue)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [columnId, setColumnId] = useState<number | null>(null)
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(null)
  const [labelIds, setLabelIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  // Why: a second key event can arrive before `submitting` renders; the ref closes that gap.
  const inFlightRef = useRef(false)
  const columns = [...(metadata?.columns ?? [])].sort((a, b) => a.position - b.position)
  const members = metadata?.members ?? []
  const labels = metadata?.labels ?? []
  // Metadata can land after the dialog opens; fall back to its default until the user picks.
  const effectiveColumnId = columnId ?? defaultColumnId(metadata)
  const submit = (): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    setSubmitting(true)
    void createItsaplanIssue({
      projectRef,
      title: trimmedTitle,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(effectiveColumnId !== null ? { columnId: effectiveColumnId } : {}),
      assigneeUserId,
      ...(labelIds.length > 0 ? { labelIds } : {})
    })
      .then((result) => {
        if (!result.ok) {
          toast.error(result.message)
          return
        }
        onCreated(result.issue)
      })
      .catch(() => {
        toast.error(t('taskProviders.itsaplan.createFailed', 'Failed to create the issue.'))
      })
      .finally(() => {
        inFlightRef.current = false
        setSubmitting(false)
      })
  }
  const labelsLabel =
    labelIds.length === 0
      ? t('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
      : t('taskProviders.itsaplan.labelCount', '{{count}} labels', {
          count: labelIds.length,
          defaultValue_one: '{{count}} label'
        })
  return (
    <div
      className="-m-6 flex flex-col"
      onKeyDown={(event) => {
        if (isScreenSubmitShortcut(event)) {
          event.preventDefault()
          submit()
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/10 px-5 py-3">
        <DialogTitle size="compact">
          {t('auto.components.TaskPage.c11105dac5', 'New Issue')}
        </DialogTitle>
        <span className="text-xs text-muted-foreground/40">/</span>
        <span className="text-xs font-medium text-foreground">
          {metadata?.project.key ?? projectRef}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-6 py-4">
        <ImeInput
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // Modified Enter bubbles to the form's submit-shortcut handler.
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              !isScreenSubmitShortcut(event)
            ) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={t('auto.components.TaskPage.d9151fd4e9', 'Issue title')}
          disabled={submitting}
          className="w-full border-none bg-transparent p-0 text-lg font-semibold text-foreground outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:ring-0"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t(
            'taskProviders.itsaplan.descriptionPlaceholder',
            'Add description (Markdown)...'
          )}
          rows={5}
          disabled={submitting}
          className="max-h-60 resize-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={effectiveColumnId !== null ? String(effectiveColumnId) : undefined}
            onValueChange={(value) => setColumnId(Number(value))}
            disabled={submitting || columns.length === 0}
          >
            <SelectTrigger
              size="sm"
              density="compact"
              className="w-[160px]"
              aria-label={t('auto.components.TaskPage.154b0fa623', 'Status')}
            >
              <SelectValue placeholder={t('auto.components.TaskPage.154b0fa623', 'Status')} />
            </SelectTrigger>
            <SelectContent>
              {columns.map((column) => (
                <SelectItem key={column.id} value={String(column.id)}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={assigneeUserId ?? UNASSIGNED}
            onValueChange={(value) => setAssigneeUserId(value === UNASSIGNED ? null : value)}
            disabled={submitting}
          >
            <SelectTrigger
              size="sm"
              density="compact"
              className="w-[180px]"
              aria-label={t('auto.components.TaskPage.d2a876ca53', 'Assignee')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>
                {t('auto.components.TaskPage.42a9160321', 'Unassigned')}
              </SelectItem>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"

                disabled={submitting || labels.length === 0}
              >
                {labelsLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {labels.map((label) => (
                <DropdownMenuCheckboxItem
                  key={label.id}
                  checked={labelIds.includes(label.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() =>
                    setLabelIds((current) =>
                      current.includes(label.id)
                        ? current.filter((id) => id !== label.id)
                        : [...current, label.id]
                    )
                  }
                >
                  <span className="truncate">{label.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-border/60 bg-muted/5 px-6 py-4">
        <span className="text-[10px] font-medium text-muted-foreground/60">
          {t('auto.components.TaskPage.shortcutToSubmit', '{{shortcut}} to submit.', {
            shortcut: submitShortcutLabel
          })}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {t('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!title.trim() || submitting}>
            {submitting ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin" />
                {t('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
              </>
            ) : (
              t('auto.components.TaskPage.e15ba2d2eb', 'Create issue')
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function TaskPageItsaplanIssueDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    newItsaplanIssueOpen,
    setNewItsaplanIssueOpen,
    itsaplanProjectRef,
    itsaplanMetadata,
    submitShortcutLabel,
    openItsaplanDetailPage,
    refreshItsaplan
  } = model
  if (!itsaplanProjectRef) {
    return null
  }
  return (
    <Dialog open={newItsaplanIssueOpen} onOpenChange={setNewItsaplanIssueOpen}>
      <DialogContent showCloseButton={false} className="flex flex-col overflow-hidden sm:max-w-2xl">
        {newItsaplanIssueOpen ? (
          <ItsaplanIssueForm
            key={itsaplanProjectRef}
            projectRef={itsaplanProjectRef}
            metadata={itsaplanMetadata}
            submitShortcutLabel={submitShortcutLabel}
            onCancel={() => setNewItsaplanIssueOpen(false)}
            onCreated={(issue) => {
              setNewItsaplanIssueOpen(false)
              refreshItsaplan()
              openItsaplanDetailPage(issue)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
