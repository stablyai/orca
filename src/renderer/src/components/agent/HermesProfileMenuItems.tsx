import { Check } from 'lucide-react'

import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { HermesProfilesSnapshot } from '../../../../shared/hermes-profiles'

/** Launch Hermes in a named profile; `null` is the root/default profile. */
export function HermesProfileMenuItems({
  snapshot,
  disabled,
  onSelect
}: {
  snapshot: HermesProfilesSnapshot
  disabled?: boolean
  onSelect: (profile: string | null) => void
}) {
  const t = useTranslate()
  if (snapshot.profiles.length === 0) {
    return null
  }
  const active = snapshot.activeProfile
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger variant="launch-row" className="h-9" disabled={disabled}>
        <span className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2.5">
          <AgentIcon agent="hermes" size={14} />
          <span className="min-w-0 flex-1 truncate text-left">
            {t('agentPicker.hermesProfiles', 'Profiles')}
          </span>
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
            {active === 'default'
              ? t('agentPicker.hermesProfileDefault', 'Default profile')
              : active}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent variant="picker" className="w-56">
        <DropdownMenuLabel>{t('agentPicker.hermesProfiles', 'Profiles')}</DropdownMenuLabel>
        <DropdownMenuItem disabled={disabled} onSelect={() => onSelect(null)}>
          <span className="min-w-0 flex-1 truncate">
            {t('agentPicker.hermesProfileDefault', 'Default profile')}
          </span>
          {active === 'default' ? <Check className="size-3.5" /> : null}
        </DropdownMenuItem>
        {snapshot.profiles.map((profile) => (
          <DropdownMenuItem key={profile} disabled={disabled} onSelect={() => onSelect(profile)}>
            <span className="min-w-0 flex-1 truncate">{profile}</span>
            {active === profile ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
