import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { HermesProfileItems } from '../hermes-profile-items'
import { resolveTuiAgentLaunchRawArgs } from '../../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { HermesLaunchProfiles } from '../../../../../shared/hermes/hermes-launch-profiles'
import { useAppStore } from '@/store/index'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { rowTitle } from './agent-menu-row-presentation'
import { withHermesProfileArgs } from '../../../../../shared/agent-launch/startup/hermes-profile'

/** Launch Hermes in one of its named profiles: `--profile <id>` folds into the pane's Arguments. */
export function HermesProfileSubmenu({
  row,
  profiles,
  pendingReason,
  disabled,
  runLaunch,
  children
}: {
  row: Extract<NewTabAgentMenuRow, { kind: 'cli' }>
  profiles: HermesLaunchProfiles
  pendingReason?: string
  disabled?: boolean
  runLaunch: (
    row: NewTabAgentMenuRow,
    draft?: AgentPickerDraft,
    pickerEntry?: AgentPickerEntry,
    agentArgsOverride?: string
  ) => boolean | void | Promise<boolean>
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const launchProfile = (profile: string | null) => {
    // A menu pick always wins, and Default is explicit: bare `hermes` follows the host's sticky
    // profile, which would contradict the marked item on a host with a named active profile.
    const configuredArgs = resolveTuiAgentLaunchRawArgs('hermes', settings)
    runLaunch(
      row,
      undefined,
      undefined,
      withHermesProfileArgs(configuredArgs, profile ?? 'default')
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        variant="launch-row"
        disabled={disabled || !!pendingReason}
        aria-description={pendingReason}
        title={rowTitle(
          row,
          getAgentCatalog().find((entry) => entry.id === row.agent)?.label ?? row.agent,
          t
        )}
      >
        {children}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-0">
        <HermesProfileItems
          profiles={profiles.profiles}
          current={profiles.active}
          onPick={launchProfile}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
