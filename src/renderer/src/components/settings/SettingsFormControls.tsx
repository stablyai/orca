import type React from 'react'
import { useState } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Switch } from '../ui/switch'
import { normalizeColor } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export { FontAutocomplete } from './FontAutocomplete'
export { ThemePicker } from './TerminalThemePicker'

type SettingsSwitchProps = {
  checked: boolean
  onChange: () => void
  ariaLabel?: string
  ariaLabelledBy?: string
  disabled?: boolean
}

export function SettingsSwitch({
  checked,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  disabled
}: SettingsSwitchProps): React.JSX.Element {
  return (
    <Switch
      checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onCheckedChange={onChange}
    />
  )
}

type SettingsRowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  control: React.ReactNode
  className?: string
  /** Optional id applied to the label so the control can reference it via aria-labelledby. */
  labelId?: string
  /** When true, top-align label/description and control. Useful for tall control columns. */
  alignTop?: boolean
}

/** Two-column row grammar: left min-w-0 label+description, right shrink-0 control. */
export function SettingsRow({
  label,
  description,
  control,
  className,
  labelId,
  alignTop
}: SettingsRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex gap-4',
        description ? 'py-3' : 'py-2',
        alignTop ? 'items-start' : 'items-center justify-between',
        className
      )}
    >
      <div className={cn('min-w-0 flex-1', description ? 'space-y-1' : 'space-y-0.5')}>
        <Label id={labelId} className="select-text">
          {label}
        </Label>
        {description ? (
          <p className="select-text text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

type SettingsSwitchRowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  checked: boolean
  onChange: () => void
  className?: string
  ariaLabel?: string
  disabled?: boolean
}

export function SettingsSwitchRow({
  label,
  description,
  checked,
  onChange,
  className,
  ariaLabel,
  disabled
}: SettingsSwitchRowProps): React.JSX.Element {
  return (
    <SettingsRow
      label={label}
      description={description}
      className={className}
      control={
        <SettingsSwitch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        />
      }
    />
  )
}

type SegmentedOption<T extends string | number> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
  ariaLabel?: string
  /** Optional hover label describing what the option does. */
  tooltip?: React.ReactNode
}

type SettingsSegmentedControlProps<T extends string | number> = {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel?: string
  size?: 'sm' | 'md'
  equalWidth?: boolean
}

/** Canonical segmented control for theme/ligatures/cursor/shell/etc. */
export function SettingsSegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'md',
  equalWidth = false
}: SettingsSegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-background/50 p-0.5',
        equalWidth && 'w-full'
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const button = (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            // Why aria-disabled, not disabled: a native disabled button leaves the tab
            // order, so keyboard users can never focus it to open the tooltip explaining
            // why the option is unavailable. The click guard below keeps it inert.
            aria-disabled={opt.disabled}
            onClick={() => {
              if (!opt.disabled) {
                onChange(opt.value)
              }
            }}
            className={cn(
              'rounded-sm text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
              equalWidth && 'flex-1',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : opt.disabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        )
        if (opt.tooltip == null) {
          return button
        }
        return (
          <Tooltip key={String(opt.value)}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{opt.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

type SettingsBadgeProps = {
  tone?: 'neutral' | 'accent' | 'muted'
  children: React.ReactNode
  className?: string
}

/** Tokenized badge for status pills inside settings (e.g. Detected, Not installed). */
export function SettingsBadge({
  tone = 'neutral',
  children,
  className
}: SettingsBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'accent'
          ? 'border-foreground/20 bg-foreground/10 text-foreground'
          : tone === 'muted'
            ? 'border-border/40 bg-muted/30 text-muted-foreground'
            : 'border-border/50 bg-background/50 text-foreground/80',
        className
      )}
    >
      {children}
    </span>
  )
}

type SettingsSubsectionHeaderProps = {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Consistent subsection header: h3 text-sm font-semibold + optional muted description. */
export function SettingsSubsectionHeader({
  title,
  description,
  action,
  className
}: SettingsSubsectionHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

type ColorFieldProps = {
  label: string
  description: string
  value: string
  fallback: string
  onChange: (value: string) => void
}

type NumberFieldProps = {
  label: string
  description: string
  value: number
  defaultValue?: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
}

export function ColorField({
  label,
  description,
  value,
  fallback,
  onChange
}: ColorFieldProps): React.JSX.Element {
  const normalized = normalizeColor(value, fallback)

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={normalized}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-10 rounded-md border border-input bg-transparent p-1"
          />
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={fallback}
            className="w-32 text-xs"
          />
        </div>
      }
    />
  )
}

export function NumberField({
  label,
  description,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onChange,
  suffix
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '')
  const [prevValue, setPrevValue] = useState(value)

  // Sync draft when the external value changes (e.g. from another source)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(Number.isFinite(value) ? String(value) : '')
  }

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') {
      // Empty input — reset to current value rather than committing 0
      setDraft(Number.isFinite(value) ? String(value) : '')
      return
    }
    const next = Number(trimmed)
    if (Number.isFinite(next)) {
      const clamped = Math.min(max, Math.max(min, next))
      onChange(clamped)
      setDraft(String(clamped))
    } else {
      // Reset to current value if input is invalid
      setDraft(Number.isFinite(value) ? String(value) : '')
    }
  }

  return (
    <SettingsRow
      label={label}
      description={
        <>
          {description}
          {defaultValue !== undefined ? (
            <span className="ml-1 text-muted-foreground/70">
              {translate('auto.components.settings.SettingsFormControls.b661b034ec', '· Default:')}{' '}
              {defaultValue}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commit()
              }
            }}
            className="number-input-clean w-24 tabular-nums"
          />
          {suffix ? <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span> : null}
        </div>
      }
    />
  )
}
