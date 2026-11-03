import type { buildNewTabAgentMenuRows } from '@/lib/new-tab-agent-menu-rows'
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
      pickerContext?: {
        launchCwd?: string | null
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

/** Compare selected launch references before deriving source, profile or catalog views. */
export function sameAgentLaunchPickerModel(a: NewTabAgentMenuModel, b: NewTabAgentMenuModel) {
  if (a === b) {
    return true
  }
  if (a.state !== 'settled' || b.state !== 'settled') {
    return (
      a.state === 'loading' && b.state === 'loading' && a.placeholderCount === b.placeholderCount
    )
  }
  const x = a.pickerContext
  const y = b.pickerContext
  const same = (x: readonly unknown[], y: readonly unknown[]) =>
    x.length === y.length && x.every((value, index) => value === y[index])
  return same(
    [
      a.defaultTuiAgent,
      x?.key,
      x?.launchCwd,
      x?.executionHostId,
      x?.pairingRevision,
      x?.runtimeId,
      x?.workspace.kind,
      x?.workspace.repoId,
      x?.workspace.worktreeId,
      x?.workspace.executionHostId,
      x?.workspace.executionContext,
      x?.workspace.runtimeEnvironmentId,
      x?.settings?.agentDefaultArgs,
      x?.settings?.agentLaunchChoices,
      x?.settings?.agentPermissionDefault,
      x?.settings?.agentPermissionOverrides,
      x?.settings?.nativeChatSessionOptions,
      x?.settings?.nativeChatPermissionMode,
      ...(a.detection.detectedIds ?? []),
      ...a.rows.flatMap((row) => [
        row.agent,
        row.kind,
        row.executionHostId,
        'reason' in row ? row.reason : undefined
      ])
    ],
    [
      b.defaultTuiAgent,
      y?.key,
      y?.launchCwd,
      y?.executionHostId,
      y?.pairingRevision,
      y?.runtimeId,
      y?.workspace.kind,
      y?.workspace.repoId,
      y?.workspace.worktreeId,
      y?.workspace.executionHostId,
      y?.workspace.executionContext,
      y?.workspace.runtimeEnvironmentId,
      y?.settings?.agentDefaultArgs,
      y?.settings?.agentLaunchChoices,
      y?.settings?.agentPermissionDefault,
      y?.settings?.agentPermissionOverrides,
      y?.settings?.nativeChatSessionOptions,
      y?.settings?.nativeChatPermissionMode,
      ...(b.detection.detectedIds ?? []),
      ...b.rows.flatMap((row) => [
        row.agent,
        row.kind,
        row.executionHostId,
        'reason' in row ? row.reason : undefined
      ])
    ]
  )
}
