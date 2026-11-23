import { Check } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

/** Default plus each named profile, marking the one in force; `null` is the default profile. */
export function HermesProfileItems({
  profiles,
  current,
  disabled,
  onPick
}: {
  profiles: readonly string[]
  current: string | null
  disabled?: boolean
  onPick: (profile: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const item = (profile: string | null, label: string) => (
    <DropdownMenuItem
      key={profile ?? 'default'}
      disabled={disabled}
      onSelect={() => {
        onPick(profile)
      }}
    >
      {label}
      {current === profile ? <Check className="ml-auto size-4" /> : null}
    </DropdownMenuItem>
  )
  return (
    <>
      {item(null, t('agentPicker.hermesDefaultProfile', 'Default'))}
      {profiles.map((profile) => item(profile, profile))}
    </>
  )
}
