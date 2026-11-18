import React, { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import gmailLogo from '@/assets/google-products/gmail.svg'
import calendarLogo from '@/assets/google-products/calendar.svg'
import driveLogo from '@/assets/google-products/drive.svg'
import docsLogo from '@/assets/google-products/docs.svg'
import sheetsLogo from '@/assets/google-products/sheets.svg'
import {
  GOOGLE_SERVICE_CHOICES,
  googleChoices,
  type GoogleServiceChoice
} from '../../../../../shared/google/google-scopes'
import { googleChoiceDescription, googleChoiceLabel } from './google-copy'

// Google's own product icons, in their brand colors.
const LOGOS: Record<GoogleServiceChoice, readonly string[]> = {
  gmail: [gmailLogo],
  calendar: [calendarLogo],
  files: [driveLogo, docsLogo, sheetsLogo]
}

/** The logos for these choices, in order. */
export function googleChoiceLogos(choices: readonly GoogleServiceChoice[]): string[] {
  return choices.flatMap((choice) => LOGOS[choice])
}

// Overlapping tiles like the folded Bots header faces; the ring cuts each from the one under it.
export function GoogleLogoStack({ logos }: { logos: readonly string[] }): React.JSX.Element {
  return (
    <span className="isolate flex shrink-0 items-center -space-x-2">
      {logos.map((logo, index) => (
        <span
          key={logo}
          className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted ring-2 ring-background"
          style={{ zIndex: logos.length - index }}
        >
          <img src={logo} alt="" className="size-3.5" />
        </span>
      ))}
    </span>
  )
}

function ChoiceLogos({ choice }: { choice: GoogleServiceChoice }): React.JSX.Element {
  return (
    <span className="flex w-14 shrink-0">
      <GoogleLogoStack logos={LOGOS[choice]} />
    </span>
  )
}

function Choice({
  choice,
  checked,
  onChange
}: {
  choice: GoogleServiceChoice
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
    >
      <ChoiceLogos choice={choice} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{googleChoiceLabel(choice)}</span>
        <span className="text-xs text-muted-foreground">{googleChoiceDescription(choice)}</span>
      </span>
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
    </label>
  )
}

/** Gmail, Calendar, Drive/Docs/Sheets. Name lookup comes with any of them, so it has no box. */
export function GoogleServicePicker({
  value,
  onChange,
  offered = GOOGLE_SERVICE_CHOICES
}: {
  value: readonly GoogleServiceChoice[]
  onChange: (next: GoogleServiceChoice[]) => void
  offered?: readonly GoogleServiceChoice[]
}): React.JSX.Element {
  return (
    <div className="-mx-2 space-y-1">
      {offered.map((choice) => (
        <Choice
          key={choice}
          choice={choice}
          checked={value.includes(choice)}
          onChange={(checked) =>
            onChange(
              googleChoices(
                checked ? [...value, choice] : value.filter((entry) => entry !== choice)
              )
            )
          }
        />
      ))}
    </div>
  )
}
