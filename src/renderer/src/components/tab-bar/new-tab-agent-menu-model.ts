import { translate } from '@/i18n/i18n'
import type { buildNewTabAgentMenuRows, NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import type { AgentPickerDefaultSettings } from '../../../../shared/agent-launch-picker'

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | {
      state: 'settled'
      rows: ReturnType<typeof buildNewTabAgentMenuRows>
      detection: UseDetectedAgentsResult
      /** The default these rows were ordered by, so the new-agent badge marks the same agent. */
      defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
      /** The host is still connecting, so terminal choices wait; chat choices do not. */
      terminalPending?: boolean
      pickerContext?: {
        workspace: ProspectiveWorkspace
        executionHostId: string
        pairingRevision?: number
        runtimeId?: string | null
        settings: AgentPickerDefaultSettings | null
        key: string
      }
    }

/** A launch whose workspace may not exist yet, or that starts in a directory of its own. */
export type AgentMenuRowsTarget = {
  workspace: ProspectiveWorkspace
  /** Only a terminal can start here, so chat rows say so instead of dropping the directory. */
  launchCwd?: string | null
}

/** A chat uses host admission; only a terminal needs the host's shell before it can start. */
export function terminalPendingReason(
  terminalPending: boolean | undefined,
  row: NewTabAgentMenuRow | undefined
): string | undefined {
  return terminalPending && (row?.kind === 'cli' || row?.kind === 'terminal')
    ? translate('auto.components.NewWorkspaceComposerCard.connectingHost', 'Connecting…')
    : undefined
}
