import { planLaunchAgentStartupPrompt } from '@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { terminalSessionOptionInputs } from '../../../../shared/agent-launch/startup/tui-agent-launch-command'
import { resolveStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { useAppStore } from '@/store/index'
import type { ComposerModel } from './composer-model'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/workspace/creation/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import type { AgentStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-startup'

import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import '@/diagnostics/telemetry/telemetry'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { translate } from '@/i18n/i18n'
import { requireExecutionHostPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import type { ExecutionHostPlatformFact } from '@/runtime/hosts/platform/execution-host-platform-fact'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  prompt: string
  draftPrompt: string | null | undefined
  promptDelivery?: WorktreeCreationRequest['promptDelivery']
  settings: GlobalSettings | null | undefined
  /** Withheld fails an agent launch; a workspace created without an agent never reads it. */
  launchHost: ExecutionHostPlatformFact
  shell: AgentStartupShell | null | undefined
  isRemote: boolean
  telemetrySource: WorktreeCreationRequest['telemetrySource']
  launchInputs?: WorktreeCreationRequest['launchInputs']
  route?: WorktreeCreationRequest['agentLaunchRoute']
}

export type QuickComposerStartup = {
  promptPlan?: ReturnType<typeof planLaunchAgentStartupPrompt>
  creationStartup?: WorktreeCreationRequest['creationStartup']
  startupPlan: AgentStartupPlan | null
  backendStartup: WorktreeCreationRequest['startup']
  telemetry: AgentStartedTelemetry | null
}

export function buildQuickComposerStartup(input: QuickComposerStartupInput): QuickComposerStartup {
  const { agent, draftPrompt, prompt, settings } = input
  const inputs =
    agent === null
      ? null
      : resolveAgentStartupPlanInputs({
          agent,
          settings: settings ?? {},
          agentArgs: input.launchInputs?.agentArgs,
          sessionOptions: input.launchInputs?.sessionOptions,
          platform: requireExecutionHostPlatform(input.launchHost),
          shell: input.shell ?? undefined,
          isRemote: input.isRemote
        })
  const promptPlan = inputs
    ? planLaunchAgentStartupPrompt({
        base: inputs,
        prompt: draftPrompt ?? prompt,
        promptDelivery: draftPrompt ? 'draft' : (input.promptDelivery ?? 'auto-submit'),
        submitFollowup: true,
        isFollowupPath: TUI_AGENT_CONFIG[inputs.agent].promptInjectionMode === 'stdin-after-start'
      })
    : undefined
  const startupPlan = promptPlan?.startupPlan ?? null
  if (startupPlan && promptPlan?.pasteDraftAfterLaunch) {
    if (promptPlan.submitPastedPrompt) {
      startupPlan.followupPrompt = promptPlan.pasteDraftAfterLaunch
    } else {
      startupPlan.draftPrompt = promptPlan.pasteDraftAfterLaunch
    }
  }
  if (agent && input.route !== 'structured-native-chat' && !startupPlan) {
    throw new Error(
      translate(
        'agentPicker.workspaceStartupFailed',
        'Could not start {{agent}}. Check Arguments in this setup and try again.',
        { agent: getAgentLabel(agent) }
      )
    )
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source:
            input.telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          request_kind: 'new'
        }
  const backendStartup =
    startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
          ...(agent ? { launchAgent: agent } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          ...(telemetry ? { telemetry } : {})
        }
      : undefined
  return { startupPlan, backendStartup, telemetry, promptPlan }
}

export async function prepareQuickComposerStartup(
  input: QuickComposerStartupInput & {
    repoId: string
    executionHostId: ComposerModel['selectedRepoExecutionHostId']
    legacyLaunchInputs?: WorktreeCreationRequest['legacyLaunchInputs']
    ephemeralVm?: boolean
  }
): Promise<QuickComposerStartup> {
  const preferences = input.agent
    ? await ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        repoId: input.repoId,
        executionHostId: input.executionHostId ?? undefined
      })
    : undefined
  const { prompt, draftPrompt } = input
  const settings = input.settings
    ? {
        ...input.settings,
        agentLaunchChoices: preferences?.agentLaunchChoices ?? input.settings.agentLaunchChoices
      }
    : input.settings
  const legacy = (text?: string, delivery?: WorktreeCreationRequest['promptDelivery']) =>
    buildQuickComposerStartup({
      ...input,
      prompt: text ?? prompt,
      draftPrompt: text !== undefined ? (delivery === 'draft' ? text : null) : draftPrompt,
      promptDelivery: delivery ?? input.promptDelivery,
      settings,
      launchInputs: input.legacyLaunchInputs ?? input.launchInputs
    })
  const host = parseExecutionHostId(input.executionHostId)
  const hostComposes =
    input.promptDelivery !== 'submit-after-ready' &&
    (input.launchInputs !== undefined || Boolean(draftPrompt)) &&
    !input.ephemeralVm &&
    host?.kind === 'runtime' &&
    readCachedRuntimeEnvironmentCapability(
      host.environmentId,
      WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY
    ) === true
  const eager = hostComposes ? null : legacy()
  const seed = eager?.startupPlan
    ? eager.startupPlan.sessionOptions
    : input.agent
      ? terminalSessionOptionInputs({
          agent: input.agent,
          settings: { agentLaunchChoices: settings?.agentLaunchChoices },
          agentArgs: input.launchInputs?.agentArgs,
          sessionOptions: input.launchInputs?.sessionOptions,
          shell: resolveStartupShell(
            requireExecutionHostPlatform(input.launchHost),
            input.shell ?? undefined
          )
        }).sessionOptions
      : undefined
  return {
    ...(eager ?? {
      startupPlan: null,
      backendStartup: undefined,
      telemetry: input.agent
        ? {
            agent_kind: tuiAgentToAgentKind(input.agent),
            launch_source:
              input.telemetrySource === 'onboarding'
                ? ('onboarding' as const)
                : ('new_workspace_composer' as const),
            request_kind: 'new' as const
          }
        : null
    }),
    creationStartup: { legacy, ...(seed ? { sessionOptions: seed } : {}) }
  }
}
