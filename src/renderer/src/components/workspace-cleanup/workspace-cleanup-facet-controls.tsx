import React from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { parseWorkspaceCleanupFacetNumber } from './workspace-cleanup-facet-panel-model'

/** One facet group inside the filter panel, with its own match count. */
export function FacetSection({
  title,
  matchCount,
  totalCount,
  children
}: {
  title: string
  matchCount: number
  totalCount: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {title}
        </h4>
        <span
          className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
          data-facet-count={title}
        >
          {matchCount}/{totalCount}
        </span>
      </div>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  )
}

/** Multi-select: empty selection leaves the facet unconstrained. */
export function FacetToggleList<T extends string>({
  label,
  values,
  selected,
  getLabel,
  onChange
}: {
  label?: string
  values: readonly T[]
  selected: readonly T[]
  getLabel: (value: T) => string
  onChange: (next: T[]) => void
}): React.JSX.Element {
  const selectedSet = new Set(selected)
  return (
    <FacetField label={label}>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => {
          const active = selectedSet.has(value)
          return (
            <button
              key={value}
              type="button"
              role="checkbox"
              aria-checked={active}
              aria-label={getLabel(value)}
              onClick={() =>
                onChange(
                  active ? selected.filter((entry) => entry !== value) : [...selected, value]
                )
              }
              className={cn(
                'inline-flex h-6 items-center rounded-full border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                active && 'bg-accent text-accent-foreground'
              )}
            >
              {getLabel(value)}
            </button>
          )
        })}
      </div>
    </FacetField>
  )
}

/** Single-choice segmented control for tri-state / presence / enum facets. */
export function FacetChoice<T extends string>({
  label,
  value,
  options,
  getLabel,
  onChange
}: {
  label: string
  value: T
  options: readonly T[]
  getLabel?: (value: T) => string
  onChange: (next: T) => void
}): React.JSX.Element {
  return (
    <FacetField label={label}>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            data-facet-value={option}
            aria-checked={value === option}
            aria-label={`${label}: ${getLabel ? getLabel(option) : option}`}
            onClick={() => onChange(option)}
            className={cn(
              'inline-flex h-6 items-center rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              value === option && 'bg-accent text-accent-foreground'
            )}
          >
            {getLabel ? getLabel(option) : option}
          </button>
        ))}
      </div>
    </FacetField>
  )
}

/** Free-form numeric threshold — deliberately not a fixed 30/90 enum. */
export function FacetNumberField({
  label,
  value,
  placeholder,
  suffix,
  onChange
}: {
  label: string
  value: number | null
  placeholder?: string
  suffix?: string
  onChange: (next: number | null) => void
}): React.JSX.Element {
  return (
    <FacetField label={label}>
      <div className="flex items-center gap-1.5">
        {/* Why text, not number: Chromium mutates a focused number input on every
            wheel tick, which silently walked a threshold up inside the scrollable
            facet panel. preventDefault would stop that but also stop the panel
            scrolling, re-breaking #14629. */}
        <Input
          type="text"
          inputMode="numeric"
          aria-label={label}
          value={value === null ? '' : String(value)}
          placeholder={placeholder}
          onChange={(event) => onChange(parseWorkspaceCleanupFacetNumber(event.target.value))}
          className="h-7 w-24 text-xs"
        />
        {suffix ? <span className="text-[11px] text-muted-foreground">{suffix}</span> : null}
      </div>
    </FacetField>
  )
}

export function FacetTextField({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (next: string) => void
}): React.JSX.Element {
  return (
    <FacetField label={label}>
      <Input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 text-xs"
      />
    </FacetField>
  )
}

export function FacetCheckbox({
  id,
  label,
  checked,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  const checkboxId = `workspace-cleanup-facet-${id}`
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={checkboxId}
        aria-label={label}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <Label htmlFor={checkboxId} className="cursor-pointer text-xs font-normal text-foreground">
        {label}
      </Label>
    </div>
  )
}

function FacetField({
  label,
  children
}: {
  label?: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!label) {
    return <>{children}</>
  }
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
