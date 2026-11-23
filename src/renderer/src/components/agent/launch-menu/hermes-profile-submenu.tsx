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
import { hermesProfileLaunchArgs } from './use-hermes-launch-profiles'

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
    if (!profile) {
      // The default profile is a plain launch: bare `hermes` follows its own sticky choice.
      runLaunch(row)
      return
    }
    const configuredArgs = resolveTuiAgentLaunchRawArgs('hermes', settings)
    const agentArgs = hermesProfileLaunchArgs(configuredArgs, profile)
    // A null fold keeps the user's own profile flag; the launch then runs their Arguments.
    runLaunch(row, undefined, undefined, agentArgs ?? undefined)
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
