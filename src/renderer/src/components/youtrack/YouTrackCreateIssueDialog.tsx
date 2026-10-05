import { useEffect, useId, useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type {
  YouTrackFieldSchema,
  YouTrackIssue,
  YouTrackProjectSummary
} from '../../../../shared/youtrack-types'
import { YouTrackOptionPicker, YouTrackScalarInput } from './youtrack-field-editors'
import {
  isEditableKind,
  isOptionKind,
  useYouTrackProjectFields
} from './use-youtrack-project-fields'
import { useYouTrackStore } from './youtrack-store'

const LAST_PROJECT_KEY = 'orca.youtrack.lastProjectId'
// Shown without expanding "More fields" even when optional.
const PROMINENT_FIELDS = /^(assignee|type|priority)$/i

function readLastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}

function initialValues(
  fields: YouTrackFieldSchema[],
  viewerLogin: string | null
): Record<string, string[]> {
  const values: Record<string, string[]> = {}
  for (const field of fields) {
    const assignToMe =
      field.kind === 'user' &&
      /assignee/i.test(field.name) &&
      viewerLogin !== null &&
      field.options.some((option) => option.value === viewerLogin)
    values[field.name] = assignToMe && viewerLogin ? [viewerLogin] : field.defaults
  }
  return values
}

export function YouTrackCreateIssueDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  const viewerLogin = useYouTrackStore((s) => s.status.viewer?.login ?? null)
  const [projects, setProjects] = useState<YouTrackProjectSummary[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(readLastProject)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  // Why edits over defaults: a late status load (viewer login) must not wipe what the user typed.
  const [edits, setEdits] = useState<Record<string, string[]>>({})
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const summaryId = useId()
  const descriptionId = useId()
  const { fields: schema, error: schemaError } = useYouTrackProjectFields(open ? projectId : null)
  const values = useMemo(
    () => ({ ...(schema ? initialValues(schema, viewerLogin) : {}), ...edits }),
    [schema, viewerLogin, edits]
  )

  useEffect(() => {
    if (!open || projects || !window.api?.youtrack) {
      return
    }
    void window.api.youtrack.listProjects().then((result) => {
      if (!result.ok) {
        setError(result.error)
        return
      }
      setProjects(result.projects)
      setProjectId((current) =>
        current && result.projects.some((project) => project.id === current)
          ? current
          : (result.projects[0]?.id ?? null)
      )
    })
  }, [open, projects])

  const fields = useMemo(
    () => (schema ?? []).filter((field) => field.kind !== 'state' && isEditableKind(field)),
    [schema]
  )
  const missing = fields.filter(
    (field) => field.required && (values[field.name] ?? []).every((value) => !value.trim())
  )
  const shown = fields
    .filter((field) => showAll || field.required || PROMINENT_FIELDS.test(field.name))
    .sort((a, b) => Number(b.required) - Number(a.required))
  const hiddenCount = fields.length - shown.length
  const canSubmit = Boolean(projectId && summary.trim() && missing.length === 0 && !submitting)

  const reset = (): void => {
    setSummary('')
    setDescription('')
    setError(null)
    setShowAll(false)
    setEdits({})
  }

  const handleSubmit = async (): Promise<void> => {
    const api = window.api?.youtrack
    if (!api || !projectId || !canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await api.createIssue({
      projectId,
      summary: summary.trim(),
      description: description.trim() || undefined,
      fields: fields.map((field) => ({ name: field.name, values: values[field.name] ?? [] }))
    })
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, projectId)
    } catch {
      // Remembering the project is a convenience only.
    }
    toast.success(
      translate('youtrack.create.created', 'Created {{id}}', { id: result.issue.idReadable })
    )
    reset()
    onOpenChange(false)
    onCreated(result.issue)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translate('youtrack.create.title', 'New YouTrack issue')}</DialogTitle>
          <DialogDescription>
            {translate(
              'youtrack.create.description',
              'Fields come from the selected project; required ones are marked with *.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid max-h-[65vh] gap-3 overflow-y-auto scrollbar-sleek"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="grid gap-1.5">
            <Label>{translate('youtrack.create.project', 'Project')}</Label>
            <Select
              value={projectId ?? undefined}
              onValueChange={(value) => {
                // Why: Radix's hidden form <select> reports "" before its options mount.
                if (value && value !== projectId) {
                  setProjectId(value)
                  setEdits({})
                }
              }}
              disabled={!projects}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={translate('youtrack.create.loadingProjects', 'Loading projects…')}
                />
              </SelectTrigger>
              <SelectContent>
                {(projects ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name} ({project.shortName})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={summaryId}>{translate('youtrack.create.summary', 'Summary *')}</Label>
            <Input
              id={summaryId}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={descriptionId}>
              {translate('youtrack.create.descriptionLabel', 'Description (Markdown)')}
            </Label>
            <textarea
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              className="min-h-20 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          {projectId && !schema && !schemaError ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          ) : null}
          <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
            {shown.map((field) => (
              <div key={field.name} className="grid min-w-0 gap-1">
                <span className="truncate text-[12px] text-muted-foreground">
                  {field.name}
                  {field.required ? ' *' : ''}
                </span>
                {isOptionKind(field) ? (
                  <div className="rounded-md border border-input">
                    <YouTrackOptionPicker
                      field={field}
                      values={values[field.name] ?? []}
                      onChange={(next) => setEdits((prev) => ({ ...prev, [field.name]: next }))}
                    />
                  </div>
                ) : (
                  <YouTrackScalarInput
                    field={field}
                    value={values[field.name]?.[0] ?? ''}
                    onChange={(next) => setEdits((prev) => ({ ...prev, [field.name]: [next] }))}
                  />
                )}
              </div>
            ))}
          </div>
          {hiddenCount > 0 ? (
            <Button type="button" variant="link" size="sm" onClick={() => setShowAll(true)}>
              {translate('youtrack.create.moreFields', 'More fields ({{count}})', {
                count: hiddenCount
              })}
            </Button>
          ) : null}
          {error || schemaError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error ?? schemaError}
            </div>
          ) : null}
          {missing.length > 0 && summary.trim() ? (
            <p className="text-xs text-muted-foreground">
              {translate('youtrack.create.missing', 'Required: {{fields}}', {
                fields: missing.map((field) => field.name).join(', ')
              })}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {translate('youtrack.create.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {translate('youtrack.create.submit', 'Create issue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
