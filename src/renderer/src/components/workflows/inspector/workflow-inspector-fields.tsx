import React, { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { translate } from '@/i18n/i18n'

/** Typing edits the draft without history; focusing a field records one undo step for the whole edit. */
function useFieldHistory(): { onFocus: () => void; readOnly: boolean } {
  const checkpoint = useWorkflowEditorStore((state) => state.checkpoint)
  const readOnly = useWorkflowEditorStore((state) => state.mode === 'execution')
  return { onFocus: checkpoint, readOnly }
}

export function InspectorSection({
  title,
  children,
  defaultOpen = true,
  aside
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  aside?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="border-b border-border last:border-b-0">
      <Collapsible defaultOpen={defaultOpen}>
        <div className="flex items-center gap-2 px-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex flex-1 items-center gap-1.5 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              {title}
            </button>
          </CollapsibleTrigger>
          {aside}
        </div>
        <CollapsibleContent>
          <div className="space-y-3 px-4 pb-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

export function InspectorField({
  label,
  description,
  htmlFor,
  children,
  meta
}: {
  label: string
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  meta?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="space-y-0.5">
        <Label htmlFor={htmlFor} variant="field">
          {label}
        </Label>
        {description ? (
          <p className="text-2xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
      {meta ? <div className="text-2xs text-muted-foreground">{meta}</div> : null}
    </div>
  )
}

export function TextField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  description?: React.ReactNode
  placeholder?: string
  mono?: boolean
  invalid?: boolean
}): React.JSX.Element {
  const id = useId()
  const history = useFieldHistory()
  return (
    <InspectorField label={props.label} description={props.description} htmlFor={id}>
      <Input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={history.readOnly}
        aria-invalid={props.invalid || undefined}
        onFocus={history.onFocus}
        onChange={(event) => props.onChange(event.target.value)}
        density="compact"
        variant={props.mono ? 'code' : 'default'}
      />
    </InspectorField>
  )
}

export function TextAreaField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  description?: React.ReactNode
  placeholder?: string
  rows?: number
  mono?: boolean
}): React.JSX.Element {
  const id = useId()
  const history = useFieldHistory()
  return (
    <InspectorField label={props.label} description={props.description} htmlFor={id}>
      <Textarea
        id={id}
        value={props.value}
        rows={props.rows ?? 3}
        placeholder={props.placeholder}
        readOnly={history.readOnly}
        onFocus={history.onFocus}
        onChange={(event) => props.onChange(event.target.value)}
        density="compact"
        variant={props.mono ? 'code' : 'default'}
      />
    </InspectorField>
  )
}

/** One entry per line; blank lines are dropped on save. */
export function ListField(props: {
  label: string
  value: readonly string[]
  onChange: (value: string[]) => void
  description?: string
  placeholder?: string
}): React.JSX.Element {
  return (
    <TextAreaField
      label={props.label}
      description={
        props.description ??
        translate(
          'auto.components.workflows.inspector.workflow.inspector.fields.0243e40fc4',
          'One per line.'
        )
      }
      placeholder={props.placeholder}
      rows={Math.min(6, Math.max(2, props.value.length + 1))}
      value={props.value.join('\n')}
      onChange={(text) =>
        props.onChange(
          text
            .split('\n')
            .map((line) => line.trimEnd())
            .filter((line, index, all) => line.length > 0 || index === all.length - 1)
        )
      }
    />
  )
}

export function NumberField(props: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  description?: React.ReactNode
  min?: number
  max?: number
  placeholder?: string
  suffix?: string
}): React.JSX.Element {
  const id = useId()
  const history = useFieldHistory()
  const invalid =
    props.value !== null &&
    ((props.min !== undefined && props.value < props.min) ||
      (props.max !== undefined && props.value > props.max))
  return (
    <InspectorField label={props.label} description={props.description} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={props.value ?? ''}
          min={props.min}
          max={props.max}
          placeholder={props.placeholder}
          readOnly={history.readOnly}
          aria-invalid={invalid || undefined}
          onFocus={history.onFocus}
          onChange={(event) => {
            const raw = event.target.value.trim()
            props.onChange(raw === '' ? null : Number(raw))
          }}
          density="compact"
          className="w-28"
        />
        {props.suffix ? (
          <span className="text-xs text-muted-foreground">{props.suffix}</span>
        ) : null}
      </div>
    </InspectorField>
  )
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
  description?: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const history = useFieldHistory()
  return (
    <InspectorField label={props.label} description={props.description} htmlFor={id}>
      <Select
        value={props.value}
        disabled={history.readOnly}
        onValueChange={(value) => {
          // Map back through the options so the value keeps its literal type without a cast.
          const option = props.options.find((candidate) => candidate.value === value)
          if (option) {
            history.onFocus()
            props.onChange(option.value)
          }
        }}
      >
        <SelectTrigger id={id} size="sm" density="compact" className="h-7 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </InspectorField>
  )
}

export function SwitchField(props: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  description?: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const history = useFieldHistory()
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} variant="field">
          {props.label}
        </Label>
        {props.description ? (
          <p className="text-2xs leading-4 text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={props.checked}
        disabled={history.readOnly}
        onCheckedChange={(checked) => {
          history.onFocus()
          props.onChange(checked)
        }}
      />
    </div>
  )
}

export function InspectorNote({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'warning' | 'error'
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'rounded-md border px-2.5 py-2 text-2xs leading-4',
        tone === 'muted' && 'border-border bg-muted/40 text-muted-foreground',
        tone === 'warning' &&
          'border-status-warning-border bg-status-warning-background text-status-warning-text',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      {children}
    </p>
  )
}
