// Why: renders project fields as <section> elements inside the metadata grid,
// matching the sidebar-style (bordered dropdowns) used by the issue STATUS field.
// Single-select fields get a popover; dates get a styled input; others use ProjectCell.
import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ProjectCell from './ProjectCell'
import { getAvailableColumns } from './columns'
import { useAppStore } from '@/store'
import type { GitHubItemDialogProjectOrigin } from '../GitHubItemDialog'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github-project-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

/** Fields managed by the dialog itself — not re-rendered as project fields. */
const DIALOG_OWNED_DATA_TYPES = new Set([
  'TITLE',
  'ASSIGNEES',
  'LABELS',
  'REPOSITORY',
  'MILESTONE',
  'LINKED_PULL_REQUESTS',
  'REVIEWERS',
  'PARENT_ISSUE',
  'SUB_ISSUES_PROGRESS',
  'TRACKS',
  'TRACKED_BY'
])

/** GitHub auto-generated timestamp fields — not user-editable project fields. */
const BUILTIN_TIMESTAMP_NAMES = new Set(['created', 'updated', 'closed'])

function isProjectField(f: GitHubProjectField): boolean {
  if (DIALOG_OWNED_DATA_TYPES.has(f.dataType)) {
    return false
  }
  if (f.id === '__type__') {
    return false
  }
  if (BUILTIN_TIMESTAMP_NAMES.has(f.name.toLowerCase())) {
    return false
  }
  return true
}

const SINGLE_SELECT_BUTTON_CLASS =
  'inline-flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[12px] font-medium text-foreground transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50'

const DATE_BUTTON_CLASS = SINGLE_SELECT_BUTTON_CLASS

export function ProjectFieldsGrid({
  projectOrigin
}: {
  projectOrigin: GitHubItemDialogProjectOrigin
}): React.JSX.Element | null {
  const entry = useAppStore((s) => s.projectViewCache[projectOrigin.cacheKey] ?? null)
  const table = entry?.data ?? null
  const row = useMemo(
    () => table?.rows.find((r) => r.id === projectOrigin.projectItemId) ?? null,
    [table, projectOrigin.projectItemId]
  )
  const fields = useMemo(() => {
    if (!table) {
      return []
    }
    const seen = new Set<string>()
    const all: GitHubProjectField[] = []
    const add = (f: GitHubProjectField) => {
      if (!seen.has(f.id)) {
        seen.add(f.id)
        all.push(f)
      }
    }
    for (const f of getAvailableColumns(table.selectedView)) {
      add(f)
    }
    for (const f of table.selectedView.groupByFields) {
      add(f)
    }
    for (const s of table.selectedView.sortByFields) {
      add(s.field)
    }
    // Why: project-level fields not in the view (fetched by main process)
    for (const f of table.projectFields) {
      add(f)
    }
    return all.filter(isProjectField)
  }, [table])
  const settings = useAppStore((s) => s.settings)
  const updateProjectFieldValue = useAppStore((s) => s.updateProjectFieldValue)
  const clearProjectFieldValue = useAppStore((s) => s.clearProjectFieldValue)

  const handleEditField = useCallback(
    (fieldId: string, value: GitHubProjectFieldMutationValue | null) => {
      if (value === null) {
        void clearProjectFieldValue(projectOrigin.cacheKey, projectOrigin.projectItemId, fieldId)
      } else {
        void updateProjectFieldValue(
          projectOrigin.cacheKey,
          projectOrigin.projectItemId,
          fieldId,
          value
        )
      }
    },
    [
      clearProjectFieldValue,
      projectOrigin.cacheKey,
      projectOrigin.projectItemId,
      updateProjectFieldValue
    ]
  )

  if (!row || fields.length === 0) {
    return null
  }

  return (
    <>
      <section className="col-span-full border-t border-border/40 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
          {translate(
            'auto.components.github.project.ProjectFieldsSection.projectFields',
            'Project fields'
          )}
        </span>
      </section>
      {fields.map((field) => (
        <ProjectGridSection
          key={field.id}
          row={row}
          field={field}
          onEditField={handleEditField}
          sourceSettings={settings}
          sourceHost={table?.project.host}
        />
      ))}
    </>
  )
}

function ProjectGridSection({
  row,
  field,
  onEditField,
  sourceSettings,
  sourceHost
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  onEditField: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  sourceHost?: string
}): React.JSX.Element {
  if (field.kind === 'single-select') {
    return <ProjectSingleSelectSection row={row} field={field} onEditField={onEditField} />
  }
  if (field.dataType === 'DATE') {
    return <ProjectDateSection row={row} field={field} onEditField={onEditField} />
  }
  return (
    <section className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {field.name}
      </div>
      <ProjectCell
        row={row}
        field={field}
        editable={row.itemType !== 'REDACTED'}
        onEditField={onEditField}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
      />
    </section>
  )
}

function ProjectSingleSelectSection({
  row,
  field,
  onEditField
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  onEditField: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const value = row.fieldValuesByFieldId[field.id]
  const currentName = value?.kind === 'single-select' ? value.name : null
  const currentColor = value?.kind === 'single-select' ? value.color : ''
  const options = field.kind === 'single-select' ? field.options : []

  const colorHex = (c: string): string => {
    const map: Record<string, string> = {
      GRAY: '#9ca3af',
      BLUE: '#3b82f6',
      GREEN: '#22c55e',
      RED: '#ef4444',
      YELLOW: '#eab308',
      PURPLE: '#a855f7',
      PINK: '#ec4899',
      ORANGE: '#f97316'
    }
    return map[c.toUpperCase()] ?? map.GRAY
  }

  return (
    <section className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {field.name}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={SINGLE_SELECT_BUTTON_CLASS}>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ background: currentColor ? colorHex(currentColor) : '#9ca3af' }}
              />
              {currentName ?? (
                <span className="text-muted-foreground">
                  {translate('auto.components.github.project.ProjectCell.e369bf4fec', 'Select')}
                </span>
              )}
            </span>
            <ChevronDown className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-1" align="start">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-accent"
              onClick={() => {
                onEditField(field.id, { kind: 'single-select', optionId: o.id })
                setOpen(false)
              }}
            >
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ background: colorHex(o.color) }}
              />
              {o.name}
            </button>
          ))}
          {currentName ? (
            <button
              type="button"
              className="mt-1 w-full rounded px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent"
              onClick={() => {
                onEditField(field.id, null)
                setOpen(false)
              }}
            >
              {translate('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    </section>
  )
}

function ProjectDateSection({
  row,
  field,
  onEditField
}: {
  row: GitHubProjectRow
  field: GitHubProjectField
  onEditField: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
}): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const currentDate = value?.kind === 'date' ? value.date : ''
  const [draft, setDraft] = React.useState(currentDate)
  const sourceRef = React.useRef(currentDate)
  if (sourceRef.current !== currentDate) {
    sourceRef.current = currentDate
    setDraft(currentDate)
  }

  const commit = (): void => {
    if (draft !== currentDate) {
      onEditField(field.id, draft === '' ? null : { kind: 'date', date: draft })
    }
  }

  return (
    <section className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {field.name}
      </div>
      <input
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(currentDate)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className={DATE_BUTTON_CLASS}
      />
    </section>
  )
}
