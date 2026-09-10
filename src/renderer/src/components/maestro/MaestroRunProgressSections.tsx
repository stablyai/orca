import { Check, ChevronDown, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { MaestroStatePip } from './MaestroWindowFrame'
import { maestroStateTone, type MaestroStateTone } from './maestro-window-model'

export type MaestroRunProgressRow = {
  key: string
  reference: string
  title: string
  workerLabel?: string
  detail: string
  state: string
  meta?: string
  depth?: number
}

const ROW_DEPTH_PADDING = ['pl-1.5', 'pl-4', 'pl-7', 'pl-10', 'pl-13'] as const

function RunProgressRowButton({
  row,
  depth,
  onActivate
}: {
  row: MaestroRunProgressRow
  depth: number
  onActivate: (reference: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <button
      type="button"
      className={`group flex w-full items-start gap-2 rounded-md border-l py-1 pr-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${ROW_DEPTH_PADDING[depth]} ${depth > 0 ? 'border-border/70' : 'border-transparent'}`}
      data-run-progress-depth={depth}
      data-run-progress-row-expanded={expanded ? 'true' : 'false'}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        setExpanded((current) => !current)
        onActivate(row.reference)
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="pt-1.5">
        <MaestroStatePip tone={maestroStateTone(row.state)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={`${expanded ? 'break-words' : 'truncate'} min-w-0 text-xs font-medium text-foreground`}
          >
            {row.title}
          </span>
          {row.workerLabel ? (
            <span
              className={`${expanded ? 'break-words' : 'truncate'} text-[10px] text-muted-foreground`}
            >
              {row.workerLabel}
            </span>
          ) : null}
          {row.meta ? (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{row.meta}</span>
          ) : null}
          <ChevronDown
            className={`size-3 shrink-0 self-center text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </span>
        <span
          className={`block text-[11px] leading-4 text-muted-foreground ${expanded ? 'whitespace-pre-wrap break-words' : 'overflow-hidden text-ellipsis [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]'}`}
        >
          {row.detail}
        </span>
      </span>
    </button>
  )
}

export function SectionHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <h3 className="text-[10px] font-semibold uppercase leading-4 tracking-[0.05em] text-muted-foreground">
      {children}
    </h3>
  )
}

export function ProgressMeter({
  completed,
  total,
  percent
}: {
  completed: number
  total: number
  percent?: number
}): React.JSX.Element {
  const width = percent ?? 0
  const label =
    total === 0
      ? translate(
          'auto.components.maestro.MaestroRunProgressSections.noTasks',
          'No tasks in this Run'
        )
      : translate(
          'auto.components.maestro.MaestroRunProgressSections.taskProgress',
          '{{value0}} of {{value1}} tasks complete, {{value2}} percent',
          { value0: completed, value1: total, value2: width }
        )
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total === 0 ? undefined : 100}
      aria-valuenow={total === 0 ? undefined : width}
    >
      <span
        className="block h-full rounded-full bg-[var(--workspace-status-progress)] transition-[width] motion-reduce:transition-none"
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

export function RunProgressSection({
  label,
  rows,
  onActivate
}: {
  label: string
  rows: readonly MaestroRunProgressRow[]
  onActivate: (reference: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) {
    return null
  }
  return (
    <section className="space-y-1.5" aria-label={label}>
      <SectionHeading>{label}</SectionHeading>
      <div className="space-y-1">
        {rows.map((row) => {
          const depth = Math.min(row.depth ?? 0, ROW_DEPTH_PADDING.length - 1)
          return (
            <RunProgressRowButton key={row.key} row={row} depth={depth} onActivate={onActivate} />
          )
        })}
      </div>
    </section>
  )
}

export function HealthWarning({
  label,
  detail,
  tone
}: {
  label: string
  detail: string
  tone: MaestroStateTone
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/35 px-2 py-1.5 text-[11px] leading-4">
      <span className="pt-1">
        <MaestroStatePip tone={tone} />
      </span>
      <span className="min-w-0">
        <span className="font-medium text-foreground">{label}</span>
        <span className="ml-1 text-muted-foreground">{detail}</span>
      </span>
    </div>
  )
}

export function TechnicalDisclosure({
  entries,
  open = false
}: {
  entries: readonly { label: string; value: string }[]
  open?: boolean
}): React.JSX.Element {
  const [copiedValue, setCopiedValue] = useState<string | null>(null)
  return (
    <details
      className="group rounded-md border border-border/80 bg-muted/25 px-2 py-1.5 text-[10px]"
      open={open || undefined}
    >
      <summary className="cursor-pointer select-none font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {translate(
          'auto.components.maestro.MaestroRunProgressSections.technicalDetails',
          'Technical details'
        )}
      </summary>
      <dl className="mt-1.5 space-y-1">
        {entries.map((entry) => (
          <div key={`${entry.label}:${entry.value}`} className="flex min-w-0 items-center gap-1.5">
            <dt className="w-16 shrink-0 text-muted-foreground">{entry.label}</dt>
            <dd className="min-w-0 flex-1 truncate font-mono text-foreground" title={entry.value}>
              {entry.value}
            </dd>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={translate(
                'auto.components.maestro.MaestroRunProgressSections.copyTechnicalValue',
                'Copy {{value0}}',
                { value0: entry.label }
              )}
              onClick={(event) => {
                event.stopPropagation()
                void navigator.clipboard
                  .writeText(entry.value)
                  .then(() => setCopiedValue(entry.value))
              }}
            >
              {copiedValue === entry.value ? <Check /> : <Copy />}
            </Button>
          </div>
        ))}
      </dl>
    </details>
  )
}
