import React, { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github/project-types'
import { chipStyle, colorHex, singleSelectChipColors } from './project-cell-chip-colors'
import { EmptyProjectCell } from './ProjectCellValueEditors'

type SelectionEditorProps = {
  row: GitHubProjectRow
  field: GitHubProjectField
  editable: boolean
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
}

export function ProjectSingleSelectCell({
  row,
  field,
  editable,
  onEditField
}: SelectionEditorProps): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const [open, setOpen] = useState(false)
  const options = field.kind === 'single-select' ? field.options : []
  const label =
    value?.kind === 'single-select' ? (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]',
          editable && 'cursor-pointer'
        )}
        style={chipStyle(singleSelectChipColors(value.color))}
      >
        {value.name}
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
            <EmptyProjectCell
              label={translate('auto.components.github.project.ProjectCell.e369bf4fec', 'Select')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50"
            onClick={() => {
              onEditField?.(field.id, { kind: 'single-select', optionId: option.id })
              setOpen(false)
            }}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: colorHex(option.color) }}
            />
            {option.name}
          </button>
        ))}
        <ClearSelectionButton
          onClick={() => {
            onEditField?.(field.id, null)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function ProjectIterationCell({
  row,
  field,
  editable,
  onEditField
}: SelectionEditorProps): React.JSX.Element {
  const value = row.fieldValuesByFieldId[field.id]
  const [open, setOpen] = useState(false)
  const iterations = field.kind === 'iteration' ? field.iterations : []
  const label =
    value?.kind === 'iteration' ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-xs">
        {value.title}
      </span>
    ) : null
  if (!editable) {
    return <div>{label}</div>
  }
  const pick = (id: string): void => {
    onEditField?.(field.id, { kind: 'iteration', iterationId: id })
    setOpen(false)
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
            <EmptyProjectCell
              label={translate('auto.components.github.project.ProjectCell.e369bf4fec', 'Select')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <IterationGroup
          label={translate('auto.components.github.project.ProjectCell.e17bb96881', 'Completed')}
          iterations={iterations.filter((iteration) => iteration.completed)}
          onPick={pick}
        />
        <IterationGroup
          label={translate(
            'auto.components.github.project.ProjectCell.191905e20e',
            'Current & upcoming'
          )}
          iterations={iterations.filter((iteration) => !iteration.completed)}
          onPick={pick}
        />
        <ClearSelectionButton
          onClick={() => {
            onEditField?.(field.id, null)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function IterationGroup({
  label,
  iterations,
  onPick
}: {
  label: string
  iterations: { id: string; title: string; startDate: string; duration: number }[]
  onPick: (id: string) => void
}): React.JSX.Element | null {
  if (iterations.length === 0) {
    return null
  }
  return (
    <>
      <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {iterations.map((iteration) => (
        <button
          key={iteration.id}
          type="button"
          className="flex w-full flex-col items-start rounded px-2 py-1 hover:bg-muted/50"
          onClick={() => onPick(iteration.id)}
        >
          <span className="text-sm">{iteration.title}</span>
          <span className="text-[10px] text-muted-foreground">
            {iteration.startDate} · {iteration.duration}d
          </span>
        </button>
      ))}
    </>
  )
}

function ClearSelectionButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
      onClick={onClick}
    >
      {translate('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
    </button>
  )
}
