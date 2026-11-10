// @protected-copy: preserve copy used by security settings.
import type React from 'react'
import { useState } from 'react'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SettingsDisabledControlTooltip } from './SettingsDisabledControlTooltip'
import { normalizeColor } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'

export { SettingsSegmentedControl } from './SettingsSegmentedControl'

type SettingsRowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  control: React.ReactNode
  className?: string
  labelId?: string
  alignTop?: boolean
}

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
      data-settings-row=""
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
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        />
      }
    />
  )
}

type SettingsBadgeProps = {
  tone?: 'neutral' | 'accent' | 'muted'
  children: React.ReactNode
  className?: string
}

export function SettingsBadge({
  tone = 'neutral',
  children,
  className
}: SettingsBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-3xs font-medium',
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

export function SettingsSubsectionHeader({
  title,
  description,
  action,
  className
}: SettingsSubsectionHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="space-y-1">
        <h3 data-settings-group-heading="" className="text-sm font-semibold">
          {title}
        </h3>
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
  /** undefined renders the field empty — pair it with `placeholder` and `onClear` for an unset state. */
  value: number | undefined
  defaultValue?: number
  min: number
  max?: number
  step?: number
  integer?: boolean
  onChange: (value: number) => void
  /** When set, emptying the field clears the setting instead of snapping back to the current value. */
  onClear?: () => void
  /** With `onClear`, a typed 0 clears the setting like an empty field (0 means "automatic"). */
  clearOnZero?: boolean
  placeholder?: string
  suffix?: string
  className?: string
  disabled?: boolean
  disabledReason?: string
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
  integer = false,
  onChange,
  onClear,
  clearOnZero = false,
  placeholder,
  suffix,
  className,
  disabled = false,
  disabledReason
}: NumberFieldProps): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '')
  const [prevValue, setPrevValue] = useState(value)

  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(Number.isFinite(value) ? String(value) : '')
  }

  const commit = (): void => {
    if (disabled) {
      return
    }
    const revert = (): void => setDraft(Number.isFinite(value) ? String(value) : '')
    const trimmed = draft.trim()
    const next = Number(trimmed)
    if (trimmed === '' || (clearOnZero && next === 0)) {
      if (!onClear) {
        // Empty input resets rather than committing zero.
        revert()
        return
      }
      setDraft('')
      // Re-blurring an already-empty field must not write the setting again.
      if (value !== undefined) {
        onClear()
      }
      return
    }
    if (Number.isFinite(next) && (!integer || Number.isSafeInteger(next))) {
      const clamped = max === undefined ? Math.max(min, next) : Math.min(max, Math.max(min, next))
      if (clamped !== value) {
        onChange(clamped)
      }
      setDraft(String(clamped))
    } else {
      revert()
    }
  }

  return (
    <SettingsRow
      className={className}
      label={label}
      description={
        <>
          {description}
          {defaultValue !== undefined ? (
            <span className="ml-1 text-muted-foreground/70">
              {t('auto.components.settings.SettingsFormControls.b661b034ec', '· Default:')}{' '}
              {defaultValue}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <SettingsDisabledControlTooltip reason={disabled ? disabledReason : undefined}>
            <Input
              type="number"
              disabled={disabled}
              min={min}
              max={max}
              step={step}
              aria-label={label}
              placeholder={placeholder}
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
          </SettingsDisabledControlTooltip>
          {suffix ? <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span> : null}
        </div>
      }
    />
  )
}
