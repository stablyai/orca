/* eslint-disable max-lines -- Why: ProjectCell dispatches on field.dataType for every supported ProjectV2 field type; keeping the dispatch table and renderers colocated keeps the type-to-renderer mapping easy to audit. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Project field details are fetched from provider metadata IPC after the concrete field/value identity is known. */
// Why: one cell per visible column. Dispatch on `field.dataType` first (so
// built-in ASSIGNEES/LABELS cells render their dedicated content) and fall
// through to `fieldValuesByFieldId[field.id].kind` as a safety net so a
// fetched value is never silently dropped.
import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CircleDot, FileText, GitPullRequest, Lock, Plus } from 'lucide-react'
import { TYPE_FIELD_DATA_TYPE } from './columns'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useRepoAssigneesBySlug, useRepoLabelsBySlug } from '@/hooks/useGitHubSlugMetadata'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useRepoSlugIndex } from '@/lib/repo-slug-index'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import type {
  GitHubIssueType,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectLabel,
  GitHubProjectRow,
  GitHubProjectUser,
  ListIssueTypesBySlugResult
} from '../../../../shared/github-project-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type Props = {
  row: GitHubProjectRow
  field: GitHubProjectField
  editable: boolean
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  /** Called with add/remove login deltas when the inline assignees picker
   *  commits a change. The parent routes this through `patchProjectIssueOrPr`
   *  so the mutation uses the row's slug — never the active workspace repo. */
  onEditAssignees?: (add: string[], remove: string[]) => void
  /** Called with add/remove label-name deltas when the inline labels picker
   *  commits a change. Routed through `patchProjectIssueOrPr` so the mutation
   *  uses the row's slug — never the active workspace repo. */
  onEditLabels?: (add: string[], remove: string[]) => void
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
  onOpenDialog?: () => void
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

export default function ProjectCell({
  row,
  field,
  editable,
  onEditField,
  onEditAssignees,
  onEditLabels,
  onEditIssueType,
  onOpenDialog,
  sourceHost,
  sourceSettings
}: Props): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const isRedacted = row.itemType === 'REDACTED'

  // Built-in dataType dispatch first.
  if (field.dataType === 'TITLE') {
    return <TitleCell row={row} onOpenDialog={onOpenDialog} />
  }
  if (field.dataType === TYPE_FIELD_DATA_TYPE) {
    const editableHere = editable && !isRedacted && row.itemType === 'ISSUE'
    return (
      <TypeCell
        row={row}
        editable={editableHere}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditIssueType={onEditIssueType}
      />
    )
  }
  if (field.dataType === 'ASSIGNEES') {
    const editableHere = editable && !isRedacted && row.itemType !== 'DRAFT_ISSUE'
    return (
      <AssigneesCell
        row={row}
        editable={editableHere}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditAssignees={onEditAssignees}
      />
    )
  }
  if (field.dataType === 'LABELS') {
    const editableHere = editable && !isRedacted && row.itemType !== 'DRAFT_ISSUE'
    return (
      <LabelsCell
        row={row}
        editable={editableHere}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditLabels={onEditLabels}
      />
    )
  }
  if (field.dataType === 'REPOSITORY') {
    return (
      <span className="truncate text-xs text-muted-foreground">{row.content.repository ?? ''}</span>
    )
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {row.content.parentIssue ? `#${row.content.parentIssue.number}` : ''}
      </span>
    )
  }

  // Why: dispatch on the field's kind/dataType — not the value's kind — so an
  // unset cell still renders the appropriate editor and the user can assign a
  // value from scratch (e.g. set Status when it's currently empty).
  if (field.kind === 'single-select') {
    return (
      <SingleSelectCell
        row={row}
        field={field}
        editable={editable && !isRedacted}
        onEditField={onEditField}
      />
    )
  }
  if (field.kind === 'iteration') {
    return (
      <IterationCell
        row={row}
        field={field}
        editable={editable && !isRedacted}
        onEditField={onEditField}
      />
    )
  }
  if (field.dataType === 'TEXT') {
    const text = value?.kind === 'text' ? value.text : ''
    return (
      <TextCell
        value={text}
        editable={editable && !isRedacted}
        placeholder={translate('auto.components.github.project.ProjectCell.9cb1a0c984', 'Add text')}
        onCommit={(next) => {
          if (next === '') {
            onEditField?.(field.id, null)
          } else {
            onEditField?.(field.id, { kind: 'text', text: next })
          }
        }}
      />
    )
  }
  if (field.dataType === 'NUMBER') {
    const num = value?.kind === 'number' ? String(value.number) : ''
    return (
      <TextCell
        value={num}
        editable={editable && !isRedacted}
        numeric
        placeholder={translate(
          'auto.components.github.project.ProjectCell.bb7ebc11e3',
          'Add number'
        )}
        onCommit={(next) => {
          if (next === '') {
            onEditField?.(field.id, null)
            return
          }
          const parsed = Number(next)
          if (Number.isFinite(parsed)) {
            onEditField?.(field.id, { kind: 'number', number: parsed })
          }
        }}
      />
    )
  }
  if (field.dataType === 'DATE') {
    const date = value?.kind === 'date' ? value.date : ''
    return (
      <DateCell
        value={date}
        editable={editable && !isRedacted}
        onCommit={(next) => {
          if (!next) {
            onEditField?.(field.id, null)
          } else {
            onEditField?.(field.id, { kind: 'date', date: next })
          }
        }}
      />
    )
  }
  // Read-only fallback for value kinds that aren't user-editable inline
  // (labels/users baked into custom fields, plus any unknown shape).
  if (value?.kind === 'labels') {
    return (
      <div className="flex flex-wrap gap-1">
        {value.labels.map((l) => (
          <LabelChip key={l.name} label={l} />
        ))}
      </div>
    )
  }
  if (value?.kind === 'users') {
    return (
      <div className="flex flex-wrap gap-1">
        {value.users.map((u) => (
          <UserChip key={u.login} user={u} />
        ))}
      </div>
    )
  }
  return <span />
}

function TitleCell({
  row,
  onOpenDialog
}: {
  row: GitHubProjectRow
  onOpenDialog?: () => void
}): React.JSX.Element {
  if (row.itemType === 'REDACTED') {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Lock className="size-3.5" />
        <span className="italic">
          {translate('auto.components.github.project.ProjectCell.af5d8c912a', 'Restricted item')}
        </span>
      </div>
    )
  }
  // Why: only PRs get a type icon. The CircleDot used for issues/drafts added
  // visual noise without disambiguating anything (issue numbers + titles
  // already read as issues), so it's omitted.
  const content = (
    <div className="flex min-w-0 items-center gap-2">
      {row.itemType === 'PULL_REQUEST' ? (
        <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {row.content.number != null ? (
        <span className="shrink-0 text-xs text-muted-foreground">#{row.content.number}</span>
      ) : null}
      <span className="truncate text-sm font-medium">{row.content.title}</span>
    </div>
  )
  if (row.itemType === 'DRAFT_ISSUE') {
    // Why: non-interactive for drafts. Body preview is rendered in a hover
    // card (not wired here to avoid pulling in another component; see parent).
    return <div className="flex items-center gap-2">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onOpenDialog}
      className="flex h-full w-full min-w-0 cursor-pointer items-center text-left hover:underline"
    >
      {content}
    </button>
  )
}

function TypeCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditIssueType
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
}): React.JSX.Element {
  // Why: for issues we surface the repo's `issueType` (Bug/Feature/Task etc)
  // when set — that's the editable taxonomy. PR/Draft/Restricted rows render
  // the static itemType glyph because there's no equivalent editable type.
  if (row.itemType === 'ISSUE') {
    return (
      <IssueTypeCell
        row={row}
        editable={editable}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditIssueType={onEditIssueType}
      />
    )
  }
  const meta =
    row.itemType === 'PULL_REQUEST'
      ? {
          Icon: GitPullRequest,
          label: translate('auto.components.github.project.ProjectCell.d0d0e13a5a', 'PR')
        }
      : row.itemType === 'DRAFT_ISSUE'
        ? {
            Icon: FileText,
            label: translate('auto.components.github.project.ProjectCell.6efdc0d920', 'Draft')
          }
        : {
            Icon: Lock,
            label: translate('auto.components.github.project.ProjectCell.8d669084f6', 'Restricted')
          }
  const { Icon, label } = meta
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function IssueTypeCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditIssueType
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
}): React.JSX.Element {
  const issueType = row.content.issueType
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<GitHubIssueType[]>([])
  const [loading, setLoading] = useState(false)
  const [owner, repo] = (row.content.repository ?? '').split('/')
  const { lookupSlug } = useRepoSlugIndex()
  const matchedRepo = useMemo(
    () => lookupSlug(row.content.repository, sourceHost)[0] ?? null,
    [lookupSlug, row.content.repository, sourceHost]
  )
  const ownerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, matchedRepo?.id ?? null))
  )

  React.useEffect(() => {
    if (!open || !owner || !repo) {
      return
    }
    let cancelled = false
    setLoading(true)
    const target = getActiveRuntimeTarget(matchedRepo ? ownerSettings : sourceSettings)
    const request =
      target.kind === 'environment'
        ? callRuntimeRpc<ListIssueTypesBySlugResult>(
            target,
            'github.project.listIssueTypesBySlug',
            { owner, repo, ...(sourceHost ? { host: sourceHost } : {}) },
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listIssueTypesBySlug({
            owner,
            repo,
            ...(sourceHost ? { host: sourceHost } : {})
          })
    request
      .then((res) => {
        if (cancelled) {
          return
        }
        if (res.ok) {
          setOptions(res.types)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [matchedRepo, open, owner, ownerSettings, repo, sourceHost, sourceSettings])

  const trigger = (
    <span className="inline-flex items-center gap-1 text-xs">
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
      {issueType ? (
        (() => {
          const colors = singleSelectChipColors(issueType.color ?? '')
          return (
            <span
              className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]"
              style={chipStyle(colors)}
            >
              {issueType.name}
            </span>
          )
        })()
      ) : (
        <span className="text-muted-foreground">
          {translate('auto.components.github.project.ProjectCell.c5f949e489', 'Issue')}
        </span>
      )}
    </span>
  )

  if (!editable) {
    return <div>{trigger}</div>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate(
            'auto.components.github.project.ProjectCell.c7b059cf07',
            'Issue type'
          )}
          className="flex h-full w-full cursor-pointer items-center px-1 text-left"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {!owner || !repo ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.54cac64427',
              'Row has no repo slug.'
            )}
          </div>
        ) : loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate('auto.components.github.project.ProjectCell.2219e945ef', 'Loading…')}
          </div>
        ) : options.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.943b3dadc9',
              'This repo has no Issue Types.'
            )}
          </div>
        ) : (
          options.map((t) => (
            <button
              key={t.id}
              type="button"
              className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/50"
              onClick={() => {
                onEditIssueType?.(t)
                setOpen(false)
              }}
            >
              <span
                className="mt-1 inline-block size-2 shrink-0 rounded-full"
                style={{ background: colorHex(t.color ?? '') || '#8b949e' }}
              />
              <span className="min-w-0">
                <span className="block truncate">{t.name}</span>
                {t.description ? (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {t.description}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
        {issueType ? (
          <button
            type="button"
            className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
            onClick={() => {
              onEditIssueType?.(null)
              setOpen(false)
            }}
          >
            {translate('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function SingleSelectCell({
  row,
  field,
  editable,
  onEditField
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  editable: boolean
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
}): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const [open, setOpen] = useState(false)
  const options = field.kind === 'single-select' ? field.options : []
  // Why: GitHub single-select options ship a hue that is too dark to read on
  // the app's dark background when used as plain text. Reuse the label-chip
  // dark-mode mapping (translucent fill + brightened hue text) so status pills
  // stay readable across the same color palette.
  const label =
    value?.kind === 'single-select'
      ? (() => {
          const colors = singleSelectChipColors(value.color)
          return (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]',
                editable && 'cursor-pointer'
              )}
              style={chipStyle(colors)}
            >
              {value.name}
            </span>
          )
        })()
      : null
  if (!editable) {
    return <div>{label}</div>
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={field.name}
          className="flex h-full w-full cursor-pointer items-center px-1 text-left"
        >
          {label ?? (
            <EmptyCellPrompt
              label={translate('auto.components.github.project.ProjectCell.e369bf4fec', 'Select')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50"
            onClick={() => {
              onEditField?.(field.id, { kind: 'single-select', optionId: o.id })
              setOpen(false)
            }}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: colorHex(o.color) }}
            />
            {o.name}
          </button>
        ))}
        <button
          type="button"
          className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
          onClick={() => {
            onEditField?.(field.id, null)
            setOpen(false)
          }}
        >
          {translate('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
        </button>
      </PopoverContent>
    </Popover>
  )
}

function IterationCell({
  row,
  field,
  editable,
  onEditField
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  editable: boolean
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
}): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const [open, setOpen] = useState(false)
  const iterations = field.kind === 'iteration' ? field.iterations : []
  const completed = iterations.filter((it) => it.completed)
  const active = iterations.filter((it) => !it.completed)
  const label =
    value?.kind === 'iteration' ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-xs">
        {value.title}
      </span>
    ) : null
  if (!editable) {
    return <div>{label}</div>
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={field.name}
          className="flex h-full w-full cursor-pointer items-center px-1 text-left"
        >
          {label ?? (
            <EmptyCellPrompt
              label={translate('auto.components.github.project.ProjectCell.e369bf4fec', 'Select')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {completed.length > 0 ? (
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {translate('auto.components.github.project.ProjectCell.e17bb96881', 'Completed')}
          </div>
        ) : null}
        {completed.map((it) => (
          <IterationRow
            key={it.id}
            iteration={it}
            onClick={() => {
              onEditField?.(field.id, { kind: 'iteration', iterationId: it.id })
              setOpen(false)
            }}
          />
        ))}
        {active.length > 0 ? (
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.191905e20e',
              'Current & upcoming'
            )}
          </div>
        ) : null}
        {active.map((it) => (
          <IterationRow
            key={it.id}
            iteration={it}
            onClick={() => {
              onEditField?.(field.id, { kind: 'iteration', iterationId: it.id })
              setOpen(false)
            }}
          />
        ))}
        <button
          type="button"
          className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
          onClick={() => {
            onEditField?.(field.id, null)
            setOpen(false)
          }}
        >
          {translate('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
        </button>
      </PopoverContent>
    </Popover>
  )
}

function IterationRow({
  iteration,
  onClick
}: {
  iteration: { title: string; startDate: string; duration: number }
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full flex-col items-start rounded px-2 py-1 hover:bg-muted/50"
      onClick={onClick}
    >
      <span className="text-sm">{iteration.title}</span>
      <span className="text-[10px] text-muted-foreground">
        {iteration.startDate} · {iteration.duration}d
      </span>
    </button>
  )
}

function TextCell({
  value,
  editable,
  numeric,
  placeholder,
  onCommit
}: {
  value: string
  editable: boolean
  numeric?: boolean
  placeholder: string
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (!editable) {
    return <span className="truncate text-xs">{value}</span>
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="flex h-full w-full cursor-pointer items-center px-1 text-left text-xs hover:underline"
      >
        {value || <EmptyCellPrompt label={placeholder} />}
      </button>
    )
  }
  return (
    <Input
      autoFocus
      type={numeric ? 'number' : 'text'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (draft !== value) {
          onCommit(draft)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          setEditing(false)
          if (draft !== value) {
            onCommit(draft)
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setEditing(false)
          setDraft(value)
        }
      }}
      className="h-6 text-xs"
    />
  )
}

function DateCell({
  value,
  editable,
  onCommit
}: {
  value: string
  editable: boolean
  onCommit: (next: string) => void
}): React.JSX.Element {
  // Why: a date <input> fires onChange on every digit/spinner adjustment.
  // Committing on each fires a GraphQL mutation per keystroke. Buffer the
  // edit locally and commit on blur or Enter — same UX as TextCell.
  const sourceValue = value ?? ''
  const [draftState, setDraftState] = React.useState(() => ({
    sourceValue,
    draft: sourceValue
  }))
  if (draftState.sourceValue !== sourceValue) {
    setDraftState({ sourceValue, draft: sourceValue })
  }
  const draft = draftState.sourceValue === sourceValue ? draftState.draft : sourceValue
  const setDraft = (nextDraft: string): void => setDraftState({ sourceValue, draft: nextDraft })
  if (!editable) {
    return <span className="text-xs">{value}</span>
  }
  return (
    <input
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== sourceValue) {
          onCommit(draft)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(sourceValue)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="h-6 cursor-pointer rounded border border-border/50 bg-background px-1 text-xs"
    />
  )
}

function LabelChip({ label }: { label: GitHubProjectLabel }): React.JSX.Element {
  // Why: match GitHub's dark-mode label rendering — translucent fill of the
  // label color with a brighter foreground derived from the same hue. The
  // outline-only chip we had before was hard to read against the dark UI.
  const colors = labelChipColors(label.color)
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]"
      style={chipStyle(colors)}
    >
      {label.name}
    </span>
  )
}

function UserChip({ user }: { user: GitHubProjectUser }): React.JSX.Element {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.login}
        title={user.login}
        className="size-5 rounded-full border border-border/40"
      />
    )
  }
  return (
    <span
      title={user.login}
      className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[10px]"
    >
      {user.login.slice(0, 1).toUpperCase()}
    </span>
  )
}

function AssigneesCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditAssignees
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onEditAssignees?: (add: string[], remove: string[]) => void
}): React.JSX.Element {
  const assignees = row.content.assignees
  const [open, setOpen] = useState(false)

  const [owner, repo] = (row.content.repository ?? '').split('/')

  // Why: stabilize the assignee identity used as the seed list. `assignees`
  // is a fresh array every parent render, so depending on it directly would
  // refire the IPC on every unrelated re-render while the popover is open
  // (the same call the rate-limit pill is meant to discourage). Joining the
  // sorted logins gives us a stable string identity.
  const seedKey = React.useMemo(
    () =>
      assignees
        .map((a) => a.login)
        .sort()
        .join(','),
    [assignees]
  )

  const metadata = useRepoAssigneesBySlug(
    open ? owner : null,
    open ? repo : null,
    seedKey ? seedKey.split(',') : [],
    sourceSettings,
    sourceHost
  )

  const labelContent =
    assignees.length === 0 ? null : assignees.map((u) => <UserChip key={u.login} user={u} />)

  if (!editable) {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {labelContent}
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate(
            'auto.components.github.project.ProjectCell.f7cdb78efb',
            'Assignees'
          )}
          className={cn(
            'flex h-full w-full flex-wrap items-center gap-1 cursor-pointer px-1 text-xs text-muted-foreground hover:text-foreground'
          )}
        >
          {labelContent ?? (
            <EmptyCellPrompt
              label={translate('auto.components.github.project.ProjectCell.36341ffc66', 'Assign')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {!owner || !repo ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.54cac64427',
              'Row has no repo slug.'
            )}
          </div>
        ) : metadata.loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate('auto.components.github.project.ProjectCell.2219e945ef', 'Loading…')}
          </div>
        ) : (
          metadata.data.map((u) => {
            const isOn = assignees.some((a) => a.login === u.login)
            return (
              <button
                key={u.login}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) {
                    onEditAssignees?.([], [u.login])
                  } else {
                    onEditAssignees?.([u.login], [])
                  }
                }}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt="" className="size-4 rounded-full" />
                ) : null}
                {u.login}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

function LabelsCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditLabels
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onEditLabels?: (add: string[], remove: string[]) => void
}): React.JSX.Element {
  const labels = row.content.labels
  const [open, setOpen] = useState(false)

  const [owner, repo] = (row.content.repository ?? '').split('/')
  const metadata = useRepoLabelsBySlug(
    open ? owner : null,
    open ? repo : null,
    sourceSettings,
    sourceHost
  )

  const labelContent =
    labels.length === 0 ? null : labels.map((l) => <LabelChip key={l.name} label={l} />)

  if (!editable) {
    return <div className="flex flex-wrap items-center gap-1">{labelContent}</div>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate('auto.components.github.project.ProjectCell.8ae56a88a6', 'Labels')}
          className={cn('flex h-full w-full flex-wrap items-center gap-1 cursor-pointer px-1')}
        >
          {labelContent ?? (
            <EmptyCellPrompt
              label={translate(
                'auto.components.github.project.ProjectCell.2e26a06c70',
                'Add label'
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {!owner || !repo ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.54cac64427',
              'Row has no repo slug.'
            )}
          </div>
        ) : metadata.loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate('auto.components.github.project.ProjectCell.2219e945ef', 'Loading…')}
          </div>
        ) : metadata.data.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.4b5b871da8',
              'No labels in this repo.'
            )}
          </div>
        ) : (
          metadata.data.map((name) => {
            const isOn = labels.some((l) => l.name === name)
            return (
              <button
                key={name}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) {
                    onEditLabels?.([], [name])
                  } else {
                    onEditLabels?.([name], [])
                  }
                }}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {name}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

function EmptyCellPrompt({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-dashed border-border/70 bg-input/30 px-2 text-xs text-muted-foreground/80 shadow-xs hover:border-border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50">
      <Plus className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function colorHex(color: string): string {
  if (!color) {
    return 'inherit'
  }
  if (color.startsWith('#')) {
    return color
  }
  // GitHub returns 6-hex without `#`.
  if (/^[0-9a-fA-F]{6}$/.test(color)) {
    return `#${color}`
  }
  return color
}

// Why: GitHub single-select fields return color as a keyword like "RED" or
// "PURPLE", not a hex value. Map to Primer's dark-mode option palette so we
// can reuse labelChipColors for the chip styling.
const SINGLE_SELECT_HEX: Record<string, string> = {
  GRAY: '#8b949e',
  RED: '#f85149',
  ORANGE: '#db6d28',
  YELLOW: '#d29922',
  GREEN: '#3fb950',
  BLUE: '#58a6ff',
  PURPLE: '#bc8cff',
  PINK: '#db61a2'
}

type ChipColors = {
  bg: string
  fgLight: string
  fgDark: string
  border: string
}

function chipStyle(colors: ChipColors): React.CSSProperties {
  return {
    '--github-project-chip-fg-light': colors.fgLight,
    '--github-project-chip-fg-dark': colors.fgDark,
    backgroundColor: colors.bg,
    boxShadow: `inset 0 0 0 1px ${colors.border}`
  } as React.CSSProperties
}

function singleSelectChipColors(color: string): ChipColors {
  if (!color) {
    return labelChipColors('')
  }
  const upper = color.toUpperCase()
  const hex = SINGLE_SELECT_HEX[upper]
  if (hex) {
    return labelChipColors(hex)
  }
  return labelChipColors(color)
}

// Why: GitHub renders labels in dark mode as a low-alpha tint of the label
// color with text re-mapped to a lightness that reads well on the tint. We
// approximate Primer's algorithm so our chips match the GitHub UI.
function labelChipColors(color: string): ChipColors {
  const fallback = {
    bg: 'rgba(125,125,125,0.18)',
    fgLight: '#4b5563',
    fgDark: '#e6edf3',
    border: 'rgba(125,125,125,0.36)'
  }
  if (!color) {
    return fallback
  }
  const hex = color.startsWith('#') ? color.slice(1) : color
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return fallback
  }
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const [h, s] = rgbToHsl(r, g, b)
  const bg = `rgba(${r}, ${g}, ${b}, 0.18)`
  const border = `rgba(${r}, ${g}, ${b}, 0.3)`
  // Why: the dark-theme text lift turns chips into near-white-on-pastel in
  // light mode. Keep the same tint, but anchor text in the darker hue range.
  const fgLight = hslToCss(h, Math.max(s, 0.45), 0.32)
  // Primer dark-theme label: bg ~18% alpha of base, border ~30%, text lifted
  // to L≈85% so it stays bright but keeps the hue.
  const fgDark = hslToCss(h, Math.max(s, 0.5), 0.85)
  return { bg, fgLight, fgDark, border }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) {
    return [0, 0, l]
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  switch (max) {
    case rn:
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
      break
    case gn:
      h = ((bn - rn) / d + 2) * 60
      break
    default:
      h = ((rn - gn) / d + 4) * 60
  }
  return [h, s, l]
}

function hslToCss(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`
}
