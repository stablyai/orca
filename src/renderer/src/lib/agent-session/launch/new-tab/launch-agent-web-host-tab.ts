import { agentTabLaunchStore } from './launch-agent-execution-context'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { sourceControlActionAgentArgs } from '../../../../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { readLaunchPermissionChoice } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { resolveHostAgentStartupShell } from '../../../../../../shared/windows-terminal-shell'
import type { AgentLaunchChoices } from '../../../../../../shared/agent-launch/choices/agent-launch-choices'
import { structuredAgentLabel } from '../structured-agent-session-launch-label'
import type { SessionOptionValue } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { agentSessionCreateCapabilities } from '@/runtime/hosted-terminals/creation/agent-launch/agent-session-create-request'
import { AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { pairedAgentLaunchInputs } from '../../../paired-agent-launch-inputs'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { completeWebHostAgentLaunch } from '@/lib/web-host-agent-launch-completion'
import { deliverCreatedWebRuntimeAgentSessionPrompt } from '@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery'
import type { CreateWebRuntimeSessionTerminalOnHostArgs } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'
import {
  planLaunchAgentStartupPrompt,
  planHostedAgentPrompt,
  hostedAgentPromptHostFacts,
  hostedAgentPromptDelivery,
  hostedAgentPromptRequest
} from '../prompt/launch-agent-startup-prompt-plan'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { LaunchAgentStartupPromptPlan } from '../prompt/launch-agent-startup-prompt-plan'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import type { AgentTerminalLaunchCompletion } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'

/** Paired web tabs are host-owned; never create a local tab, and return tabId:null. */
export async function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  workspaceExecutionHostId?: LaunchAgentInNewTabArgs['workspaceExecutionHostId']
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  trustWorktreeId?: string
  buildStartup: (choices: AgentLaunchChoices | undefined) => LaunchAgentStartupPromptPlan
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  agentArgs?: string | null
  actionAgentArgs?: string
  launchPlatform?: NodeJS.Platform
  launchShell?: AgentStartupShell
  submitFollowup?: boolean
  viewMode?: Tab['viewMode']
  /** False opens the host's tab without selecting it. */
  activate?: boolean
  onPromptDelivered?: () => void
  selectWorktree?: boolean
  isCancelled?: () => boolean
}): Promise<{ delivered: boolean; failureNotified: boolean } & AgentTerminalLaunchCompletion> {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    cwd,
    prompt,
    promptDelivery,
    agentArgs,
    viewMode,
    onPromptDelivered
  } = args
  const failureMessage = translate(
    'agentLaunch.terminalPreparationFailed',
    "Couldn't open a terminal for {{value0}}. Check the workspace connection and agent settings, then try again.",
    { value0: structuredAgentLabel(agent) }
  )
  const hasPrompt = prompt.length > 0
  const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const runtimeId = environmentId
    ? lastVerifiedRuntimeStatus(
        useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
      )?.runtimeId
    : undefined
  let legacyPreparationCancelled = false
  let startup: LaunchAgentStartupPromptPlan
  let launch: CreateWebRuntimeSessionTerminalOnHostArgs
  try {
    const { capable, complete } = environmentId
      ? await agentSessionCreateCapabilities(environmentId).catch((error: unknown) => {
          if (
            isRuntimeCompatBlockError(error) ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            throw error
          }
          return { capable: false, complete: false }
        })
      : { capable: false, complete: false }
    const inputs = environmentId
      ? await pairedAgentLaunchInputs({ ...args, environmentId, complete, capable })
      : { preparedAgentCommand: true }
    // Why: negotiation must not retarget this launch to a replacement pairing.
    if (environmentId && getRuntimeEnvironmentRevision(environmentId) !== pairingRevision) {
      throw new DOMException('Agent launch cancelled', 'AbortError')
    }
    // Why: prompt delivery is client-owned; the host supplies launch settings.
    const hostStatus = environmentId
      ? lastVerifiedRuntimeStatus(
          useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
        )
      : undefined
    const platform = args.launchPlatform ?? hostStatus?.hostPlatform
    startup = planHostedAgentPrompt(agent, prompt, promptDelivery, {
      ...hostedAgentPromptHostFacts(platform, hostStatus?.terminalWindowsShell),
      ...(args.launchShell ? { shell: args.launchShell } : {}),
      submitFollowup: args.submitFollowup
    })
    launch = {
      worktreeId,
      environmentId,
      ...(args.trustWorktreeId ? { trustWorktreeId: args.trustWorktreeId } : {}),
      targetGroupId: groupId,
      activate: args.activate !== false,
      ...(args.activate === false ? { selectWorktree: false } : {}),
      ...(args.selectWorktree !== undefined ? { selectWorktree: args.selectWorktree } : {}),
      ...(cwd?.trim() ? { cwd } : {}),
      ...(viewMode ? { viewMode } : {}),
      agentSessionKind: 'fresh',
      launchAgent: agent,
      agent,
      ...inputs,
      ...(complete
        ? { agentSessionCreateCapability: AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY }
        : {}),
      ...hostedAgentPromptRequest(startup, prompt, promptDelivery),
      legacyAgentLaunch: async () => {
        if (
          !Object.keys(args.sessionOptions ?? {}).length &&
          args.actionAgentArgs === undefined &&
          agentArgs === undefined &&
          (!hasPrompt || promptDelivery === 'auto-submit')
        ) {
          return hasPrompt && startup.pasteDraftAfterLaunch === null ? { agentPrompt: prompt } : {}
        }
        try {
          const owner = environmentId ? { environmentId, pairingRevision, runtimeId } : null
          const hostSettings = owner
            ? await readHostAgentStartupSettings(owner).catch((error: unknown) => {
                if (error instanceof Error && error.name === 'AbortError') {
                  throw error
                }
                return null
              })
            : null
          const status = environmentId
            ? lastVerifiedRuntimeStatus(
                useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
              )
            : undefined
          if (args.isCancelled?.()) {
            throw new DOMException('Agent launch cancelled', 'AbortError')
          }
          if (
            environmentId &&
            (getRuntimeEnvironmentRevision(environmentId) !== pairingRevision ||
              (runtimeId && status?.runtimeId !== runtimeId))
          ) {
            throw new DOMException('Agent launch cancelled', 'AbortError')
          }
          if (hostSettings) {
            const platform = args.launchPlatform ?? status?.hostPlatform ?? 'linux'
            const shell =
              args.launchShell ??
              resolveHostAgentStartupShell({
                platform,
                isRemote: true,
                hostTerminalWindowsShell: status?.terminalWindowsShell
              })
            const permissionMode = readLaunchPermissionChoice(args.sessionOptions)
            const authoredArgs =
              args.actionAgentArgs !== undefined
                ? sourceControlActionAgentArgs(
                    {
                      agentArgs: args.actionAgentArgs,
                      ...(permissionMode
                        ? { launchPreferences: { agentId: agent, permissionMode } }
                        : {})
                    },
                    agent,
                    hostSettings,
                    shell
                  )
                : agentArgs
            startup = planLaunchAgentStartupPrompt({
              base: resolveAgentStartupPlanInputs({
                agent,
                settings: hostSettings,
                agentArgs: authoredArgs,
                sessionOptions: args.sessionOptions,
                platform,
                shell,
                isRemote: true
              }),
              prompt,
              promptDelivery,
              submitFollowup: args.submitFollowup,
              isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
            })
          } else {
            // Why: unavailable host recipes retain the existing no-refusal compatibility launch.
            const preferences = await ensureAgentLaunchPreferences(
              agentTabLaunchStore(useAppStore.getState(), args),
              { kind: 'git-worktree', worktreeId }
            )
            startup = args.buildStartup(preferences.agentLaunchChoices)
          }
        } catch (error) {
          legacyPreparationCancelled = error instanceof Error && error.name === 'AbortError'
          throw error
        }
        if (args.isCancelled?.()) {
          legacyPreparationCancelled = true
          throw new DOMException('Agent launch cancelled', 'AbortError')
        }
        const plan = startup.startupPlan
        if (!plan) {
          throw new Error(failureMessage)
        }
        return {
          command: plan.launchCommand,
          env: plan.env,
          launchConfig: plan.launchConfig,
          startupCommandDelivery: plan.startupCommandDelivery
        }
      }
    }
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError'
    if (!cancelled) {
      toast.error(failureMessage)
    }
    return {
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed', message: cancelled ? '' : failureMessage }
    }
  }

  if (args.isCancelled?.()) {
    return { delivered: false, failureNotified: false, outcome: { status: 'failed', message: '' } }
  }
  const created = await createWebRuntimeSessionTerminalResult(launch)
  if (args.isCancelled?.()) {
    return { delivered: false, failureNotified: false, outcome: created.outcome }
  }
  const promptDelivered =
    hasPrompt &&
    !args.isCancelled?.() &&
    (await deliverCreatedWebRuntimeAgentSessionPrompt(created, {
      agent,
      beforePaste: () => !args.isCancelled?.(),
      ...hostedAgentPromptDelivery(startup, prompt, promptDelivery)
    }))
  if (args.isCancelled?.()) {
    return { delivered: false, failureNotified: false, outcome: created.outcome }
  }
  return completeWebHostAgentLaunch({
    ...args,
    ...created,
    agent,
    worktreeId,
    prompt,
    onPromptDelivered,
    promptDelivered,
    failureMessage,
    legacyPreparationCancelled
  })
}
