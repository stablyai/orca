import React, { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Fingerprint,
  MessageSquare,
  Sparkles,
  Terminal
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatAutomationSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'

type ParsedSection = {
  heading: string
  level: number
  body: string
}

type ParsedHermesOutput = {
  title: string | null
  metadata: { label: string; value: string }[]
  sections: ParsedSection[]
}

const METADATA_LINE_PATTERN = /^\*\*([^*]+):\*\*\s+(.+?)\s*$/
const CRON_FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'weekday'] as const
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function splitSections(content: string): ParsedSection[] {
  const lines = content.split(/\r?\n/)
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null
  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) {
        current.body = current.body.trimEnd()
        sections.push(current)
      }
      current = { heading: heading[2], level: heading[1].length, body: '' }
      continue
    }
    if (current) {
      current.body += `${line}\n`
    }
  }
  if (current) {
    current.body = current.body.trimEnd()
    sections.push(current)
  }
  return sections
}

function parseHermesOutput(content: string): ParsedHermesOutput {
  const lines = content.split(/\r?\n/)
  let title: string | null = null
  const metadata: { label: string; value: string }[] = []
  let bodyStart = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!title) {
      const titleMatch = /^#\s+(?:Cron Job:\s*)?(.+?)\s*$/.exec(line)
      if (titleMatch) {
        title = titleMatch[1]
        bodyStart = index + 1
        continue
      }
    }
    const metaMatch = METADATA_LINE_PATTERN.exec(line)
    if (metaMatch) {
      metadata.push({ label: metaMatch[1].trim(), value: metaMatch[2].trim() })
      bodyStart = index + 1
      continue
    }
    if (line.trim() === '') {
      if (metadata.length > 0 || title) {
        bodyStart = index + 1
        continue
      }
      continue
    }
    if (title || metadata.length > 0) {
      break
    }
  }
  const remainder = lines.slice(bodyStart).join('\n')
  return {
    title,
    metadata,
    sections: splitSections(remainder)
  }
}

function isPromptSection(section: ParsedSection): boolean {
  return /^prompt$/i.test(section.heading.trim())
}

function isResponseSection(section: ParsedSection): boolean {
  return /^response$/i.test(section.heading.trim())
}

function isErrorSection(section: ParsedSection): boolean {
  return /^error$/i.test(section.heading.trim())
}

function formatCronTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function parseSingleCronNumber(value: string, min: number, max: number): number | null {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

function describeSimpleCron(parts: string[]): string | null {
  const [minuteField, hourField, dayOfMonthField, monthField, weekdayField] = parts
  const minute = parseSingleCronNumber(minuteField, 0, 59)
  const hour = parseSingleCronNumber(hourField, 0, 23)
  const time = minute !== null && hour !== null ? formatCronTime(hour, minute) : null

  if (time && dayOfMonthField === '*' && monthField === '*' && weekdayField === '*') {
    return `Runs daily at ${time}.`
  }
  if (
    minute !== null &&
    hourField === '*' &&
    dayOfMonthField === '*' &&
    monthField === '*' &&
    weekdayField === '*'
  ) {
    return `Runs hourly at :${String(minute).padStart(2, '0')}.`
  }
  if (
    time &&
    dayOfMonthField === '*' &&
    monthField === '*' &&
    /^(?:1-5|MON-FRI)$/i.test(weekdayField)
  ) {
    return `Runs on weekdays at ${time}.`
  }
  const weekday = parseSingleCronNumber(weekdayField, 0, 7)
  if (time && dayOfMonthField === '*' && monthField === '*' && weekday !== null) {
    return `Runs every ${WEEKDAY_NAMES[weekday === 7 ? 0 : weekday]} at ${time}.`
  }
  const dayOfMonth = parseSingleCronNumber(dayOfMonthField, 1, 31)
  if (time && dayOfMonth !== null && monthField === '*' && weekdayField === '*') {
    return `Runs monthly on day ${dayOfMonth} at ${time}.`
  }
  return null
}

function describeCronFields(parts: string[]): string {
  return parts.map((part, index) => `${CRON_FIELD_NAMES[index]} ${part}`).join(', ')
}

function getScheduleDescription(value: string): string | null {
  const trimmed = value.trim()
  if (!isValidAutomationSchedule(trimmed)) {
    return null
  }
  if (trimmed.includes('=')) {
    return formatAutomationSchedule(trimmed)
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return null
  }
  return describeSimpleCron(parts) ?? `Cron fields: ${describeCronFields(parts)}.`
}

function isScheduleMetadataLabel(label: string): boolean {
  return /^(?:schedule|cron schedule|cron)$/i.test(label.trim())
}

type MetadataIconStyle = { icon: LucideIcon; iconClass: string; ringClass: string }

function getMetadataIconStyle(label: string): MetadataIconStyle {
  const normalized = label.toLowerCase()
  if (/(^|\s)(job\s*id|id)(\s|$)/.test(normalized)) {
    return {
      icon: Fingerprint,
      iconClass: 'text-violet-400',
      ringClass: 'bg-violet-500/10 ring-1 ring-violet-500/30'
    }
  }
  if (/time|run/.test(normalized)) {
    return {
      icon: Clock,
      iconClass: 'text-sky-400',
      ringClass: 'bg-sky-500/10 ring-1 ring-sky-500/30'
    }
  }
  if (/schedule|cron/.test(normalized)) {
    return {
      icon: CalendarClock,
      iconClass: 'text-amber-400',
      ringClass: 'bg-amber-500/10 ring-1 ring-amber-500/30'
    }
  }
  return {
    icon: Sparkles,
    iconClass: 'text-muted-foreground',
    ringClass: 'bg-muted/40 ring-1 ring-border/60'
  }
}

type CollapsibleSectionProps = {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
  tone?: 'default' | 'muted'
  icon?: LucideIcon
  iconClass?: string
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  tone = 'default',
  icon: Icon,
  iconClass
}: CollapsibleSectionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-border/50',
        tone === 'muted' ? 'bg-muted/15' : 'bg-background'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground transition-colors hover:bg-muted/40"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {Icon ? <Icon className={cn('size-3.5', iconClass ?? 'text-muted-foreground')} /> : null}
        {title}
      </button>
      {open ? <div className="border-t border-border/50 px-4 py-3">{children}</div> : null}
    </section>
  )
}

type SectionCardProps = {
  title: string
  accent?: 'response' | 'error' | 'default'
  children: React.ReactNode
}

function SectionCard({ title, accent = 'default', children }: SectionCardProps): React.JSX.Element {
  const Icon = accent === 'error' ? AlertTriangle : CheckCircle2
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-lg border shadow-sm',
        accent === 'error'
          ? 'border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-background to-background'
          : accent === 'response'
            ? 'border-emerald-500/25 bg-gradient-to-br from-emerald-500/5 via-background to-background'
            : 'border-border/50 bg-background'
      )}
    >
      <header
        className={cn(
          'flex items-center gap-2 border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide',
          accent === 'error'
            ? 'border-rose-500/20 text-rose-700 dark:text-rose-300'
            : accent === 'response'
              ? 'border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
              : 'border-border/50 text-foreground'
        )}
      >
        {accent !== 'default' ? <Icon className="size-3.5" /> : null}
        {title}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

function MetadataValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  const scheduleDescription = isScheduleMetadataLabel(label) ? getScheduleDescription(value) : null

  if (!scheduleDescription) {
    return <dd className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</dd>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <dd
          tabIndex={0}
          className="mt-0.5 break-all rounded-sm font-mono text-xs text-foreground underline decoration-dotted underline-offset-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value}
        </dd>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-64 text-left">
        {scheduleDescription}
      </TooltipContent>
    </Tooltip>
  )
}

export function HermesCronOutputView({ content }: { content: string }): React.JSX.Element {
  const parsed = useMemo(() => parseHermesOutput(content), [content])

  const responseSection = parsed.sections.find(isResponseSection)
  const errorSection = parsed.sections.find(isErrorSection)
  const promptSection = parsed.sections.find(isPromptSection)
  const otherSections = parsed.sections.filter(
    (section) =>
      !isResponseSection(section) && !isErrorSection(section) && !isPromptSection(section)
  )

  const hasStructure =
    parsed.metadata.length > 0 || [responseSection, errorSection, promptSection].some(Boolean)

  if (!hasStructure) {
    return (
      <CommentMarkdown
        variant="document"
        content={content}
        className="text-sm leading-relaxed text-foreground"
      />
    )
  }

  return (
    <div className="space-y-4">
      {parsed.metadata.length > 0 ? (
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {parsed.metadata.map((entry) => {
            const { icon: Icon, iconClass, ringClass } = getMetadataIconStyle(entry.label)
            return (
              <div
                key={entry.label}
                className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/15 px-3 py-2.5"
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md',
                    ringClass
                  )}
                >
                  <Icon className={cn('size-3.5', iconClass)} />
                </span>
                <div className="min-w-0 flex-1">
                  <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {entry.label}
                  </dt>
                  <MetadataValue label={entry.label} value={entry.value} />
                </div>
              </div>
            )
          })}
        </dl>
      ) : null}

      {errorSection ? (
        <SectionCard title="Error" accent="error">
          <CommentMarkdown
            variant="document"
            content={errorSection.body}
            className="text-sm leading-relaxed text-foreground"
          />
        </SectionCard>
      ) : null}

      {responseSection ? (
        <SectionCard title="Response" accent="response">
          <CommentMarkdown
            variant="document"
            content={responseSection.body}
            className="text-sm leading-relaxed text-foreground"
          />
        </SectionCard>
      ) : null}

      {promptSection ? (
        <CollapsibleSection
          title="Prompt"
          tone="muted"
          icon={MessageSquare}
          iconClass="text-indigo-700 dark:text-indigo-400"
        >
          <CommentMarkdown
            variant="document"
            content={promptSection.body}
            className="text-sm leading-relaxed text-foreground/90"
          />
        </CollapsibleSection>
      ) : null}

      {otherSections.map((section) => (
        <CollapsibleSection
          key={section.heading}
          title={section.heading}
          tone="muted"
          icon={Terminal}
          iconClass="text-muted-foreground"
        >
          <CommentMarkdown
            variant="document"
            content={section.body}
            className="text-sm leading-relaxed text-foreground/90"
          />
        </CollapsibleSection>
      ))}
    </div>
  )
}
