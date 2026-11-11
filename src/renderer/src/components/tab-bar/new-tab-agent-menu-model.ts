import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  NewTabAgentMenuRow,
  buildNewTabAgentMenuRows
} from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProspectiveWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import type { AgentPickerDefaultSettings } from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | {
      state: 'settled'
      rows: ReturnType<typeof buildNewTabAgentMenuRows>
      detection: UseDetectedAgentsResult
      /** The default these rows were ordered by, so the new-agent badge marks the same agent. */
      defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
      terminalPending?: boolean
      pickerContext?: {
        launchCwd?: string | null
        workspace: ProspectiveWorkspace
        executionHostId: string
        /** The target host's published capabilities; `null` while unknown. */
        hostCapabilities?: readonly string[] | null
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

type SettledPickerContext = Extract<NewTabAgentMenuModel, { state: 'settled' }>['pickerContext']

/**
 * Create worktree offers per-launch setup where the host can apply the picks: this computer, or a
 * paired host that advertises the create-options capability. Older paired hosts keep the plain rows.
 */
export function pickerContextOffersAgentSetup(context: SettledPickerContext | undefined): boolean {
  if (!context) {
    return false
  }
  if (context.executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  return (
    parseExecutionHostId(context.executionHostId)?.kind === 'runtime' &&
    context.hostCapabilities?.includes(WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY) === true
  )
}

/** A menu still loading cannot offer setup; a settled one follows its picker context. */
export function modelOffersAgentSetup(model: NewTabAgentMenuModel): boolean {
  return model.state === 'settled' && pickerContextOffersAgentSetup(model.pickerContext)
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
      a.terminalPending,
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
      b.terminalPending,
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

/** Why a terminal choice waits: its host has not finished connecting. */
export function terminalPendingLabel(t: Translate = translate): string {
  return t('auto.components.NewWorkspaceComposerCard.connectingHost', 'Connecting…')
}

/** A chat uses host admission; only a terminal needs the host's shell before it can start. */
export function terminalPendingReason(
  terminalPending: boolean | undefined,
  row: NewTabAgentMenuRow | undefined,
  t?: Translate
): string | undefined {
  return terminalPending && (row?.kind === 'cli' || row?.kind === 'terminal')
    ? terminalPendingLabel(t)
    : undefined
}
