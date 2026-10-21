import React from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type {
  MachineLifetime,
  MachineProviderCapabilities
} from '../../../../shared/machine-provider-protocol'
import {
  getDefaultMachineTtl,
  getMachineTtlChoices,
  toMachineName,
  type MachineCreateDraft
} from '@/lib/machines/machine-create-draft'
import { getMachineLifetimeLabel } from '@/lib/machines/machine-copy'

const LIFETIMES: readonly MachineLifetime[] = ['persistent', 'temporary']

function formatDuration(seconds: number): string {
  const hours = seconds / 3600
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24
    return days === 1
      ? translate('auto.components.new.workspace.MachineCreateFields.days_one', '1 day')
      : translate(
          'auto.components.new.workspace.MachineCreateFields.days_other',
          '{{count}} days',
          {
            count: days
          }
        )
  }
  if (hours >= 1 && Number.isInteger(hours)) {
    return hours === 1
      ? translate('auto.components.new.workspace.MachineCreateFields.hours_one', '1 hour')
      : translate(
          'auto.components.new.workspace.MachineCreateFields.hours_other',
          '{{count}} hours',
          { count: hours }
        )
  }
  const minutes = Math.round(seconds / 60)
  return minutes === 1
    ? translate('auto.components.new.workspace.MachineCreateFields.minutes_one', '1 minute')
    : translate(
        'auto.components.new.workspace.MachineCreateFields.minutes_other',
        '{{count}} minutes',
        { count: minutes }
      )
}

/** A labelled control; `labelId` names controls a `<label for>` can't reach, like Select triggers. */
function Field({
  label,
  htmlFor,
  labelId,
  wide = false,
  children
}: {
  label: string
  htmlFor?: string
  labelId?: string
  /** Spans both columns, for values too long for half the row. */
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-wide={wide} className="min-w-0 space-y-1 data-[wide=true]:col-span-2">
      <label
        id={labelId}
        htmlFor={htmlFor}
        className="block text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

/**
 * What "New machine" creates, inside the composer's Advanced section. Every value starts at the
 * provider's default, so most people never open this; changes show up in the Run-on detail.
 */
export default function MachineCreateFields({
  draft,
  capabilities,
  worktreeName,
  onChange
}: {
  draft: MachineCreateDraft
  capabilities: MachineProviderCapabilities | undefined
  worktreeName: string
  onChange: (draft: MachineCreateDraft) => void
}): React.JSX.Element {
  const nameId = React.useId()
  const lifetimeLabelId = React.useId()
  const ttlLabelId = React.useId()
  const imageLabelId = React.useId()
  const shownName = draft.name.trim() || worktreeName
  const finalName = toMachineName(shownName)
  // Why: only say the name when the provider's rules change it; otherwise it repeats the field.
  const nameChanged = finalName !== shownName
  const supported = capabilities?.lifetimes ?? ['persistent']
  const ttlChoices = getMachineTtlChoices(capabilities)
  const images = capabilities?.images ?? []

  return (
    <div className="space-y-2">
      <div className="text-2xs font-medium text-muted-foreground">
        {translate('auto.components.new.workspace.MachineCreateFields.machine', 'Machine')}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field
          labelId={lifetimeLabelId}
          label={translate(
            'auto.components.new.workspace.MachineCreateFields.lifetime',
            'Lifetime'
          )}
        >
          <ToggleGroup
            type="single"
            variant="outline"
            value={draft.lifetime}
            onValueChange={(value) => {
              const lifetime = LIFETIMES.find((candidate) => candidate === value)
              if (!lifetime) {
                return
              }
              onChange({
                ...draft,
                lifetime,
                ttlSeconds:
                  lifetime === 'temporary'
                    ? (draft.ttlSeconds ?? getDefaultMachineTtl(capabilities))
                    : null
              })
            }}
            aria-labelledby={lifetimeLabelId}
          >
            {LIFETIMES.map((lifetime) => (
              <ToggleGroupItem
                key={lifetime}
                value={lifetime}
                disabled={!supported.includes(lifetime)}
              >
                {getMachineLifetimeLabel(lifetime)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        {draft.lifetime === 'temporary' && ttlChoices.length > 0 ? (
          <Field
            labelId={ttlLabelId}
            label={translate(
              'auto.components.new.workspace.MachineCreateFields.deleteAfter',
              'Delete after'
            )}
          >
            <Select
              value={String(draft.ttlSeconds ?? ttlChoices[0])}
              onValueChange={(value) => onChange({ ...draft, ttlSeconds: Number(value) })}
            >
              <SelectTrigger className="w-full" aria-labelledby={ttlLabelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ttlChoices.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {formatDuration(seconds)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <div />
        )}
        {images.length > 0 ? (
          <Field
            wide
            labelId={imageLabelId}
            label={translate('auto.components.new.workspace.MachineCreateFields.image', 'Image')}
          >
            <Select
              value={draft.image ?? images[0].id}
              onValueChange={(value) => onChange({ ...draft, image: value })}
            >
              <SelectTrigger className="w-full" aria-labelledby={imageLabelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {images.map((image) => (
                  <SelectItem key={image.id} value={image.id}>
                    {image.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field
          label={translate(
            'auto.components.new.workspace.MachineCreateFields.machineName',
            'Machine name'
          )}
          htmlFor={nameId}
        >
          <Input
            id={nameId}
            value={draft.name}
            placeholder={
              worktreeName ||
              translate(
                'auto.components.new.workspace.MachineCreateFields.sameAsWorktree',
                'Same as the worktree'
              )
            }
            maxLength={63}
            aria-describedby={nameChanged ? `${nameId}-final` : undefined}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
          {nameChanged ? (
            <p id={`${nameId}-final`} className="truncate text-2xs text-muted-foreground">
              {finalName
                ? translate(
                    'auto.components.new.workspace.MachineCreateFields.finalName',
                    'Named {{name}}',
                    { name: finalName }
                  )
                : translate(
                    'auto.components.new.workspace.MachineCreateFields.fallbackName',
                    'Named machine-… (a unique name)'
                  )}
            </p>
          ) : null}
        </Field>
      </div>
    </div>
  )
}
