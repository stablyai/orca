import React, { useId } from 'react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import { GOOGLE_ACCESS_LEVELS, type GoogleAccess } from '../../../../../shared/google/google-scopes'
import type { GoogleStatusView } from '../../../../../shared/google/google-connect-types'
import { googleAccessDescription, googleAccessLabel } from './google-copy'

/** Whether a sign-in on this host can ask for read-draft; an older host would grant full instead. */
export function googleOffersReadDraft(
  google: Pick<GoogleStatusView, 'accessLevels'> | null | undefined
): boolean {
  return google?.accessLevels?.includes('read-draft') === true
}

function Level({ access }: { access: GoogleAccess }): React.JSX.Element {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{googleAccessLabel(access)}</span>
        <span className="text-xs text-muted-foreground">{googleAccessDescription(access)}</span>
      </span>
      <RadioGroupItem id={id} value={access} />
    </label>
  )
}

/** Full access, or read-only plus Gmail drafts so Google itself refuses sends, changes and deletes. */
export function GoogleAccessPicker({
  value,
  onChange
}: {
  value: GoogleAccess
  onChange: (next: GoogleAccess) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <RadioGroup
      layout="rows"
      aria-label={t('bots.google.access.title', 'Access')}
      value={value}
      onValueChange={(next) => {
        const level = GOOGLE_ACCESS_LEVELS.find((entry) => entry === next)
        if (level) {
          onChange(level)
        }
      }}
      className="-mx-2"
    >
      <span className="px-2 pt-1 text-xs font-medium text-muted-foreground">
        {t('bots.google.access.title', 'Access')}
      </span>
      {GOOGLE_ACCESS_LEVELS.map((access) => (
        <Level key={access} access={access} />
      ))}
    </RadioGroup>
  )
}
