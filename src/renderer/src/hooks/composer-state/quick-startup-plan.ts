import { useAppStore } from '@/store'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import type { ComposerModel } from './composer-model'
import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  requireExecutionHostPlatform,
  type ExecutionHostPlatformFact
} from '@/lib/execution-host-facts'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  prompt: string
  draftPrompt: string | null | undefined
  settings: GlobalSettings | null | undefined
  /** Withheld fails an agent launch; a workspace created without an agent never reads it. */
  launchHost: ExecutionHostPlatformFact
  shell: AgentStartupShell | null | undefined
  isRemote: boolean
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

export type QuickComposerStartup = {
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
          platform: requireExecutionHostPlatform(input.launchHost),
          shell: input.shell ?? undefined,
          isRemote: input.isRemote
        })
  const draftLaunchPlan =
    !inputs || !draftPrompt
      ? null
      : buildAgentDraftLaunchPlan({
          ...inputs,
          draft: draftPrompt
        })
  let startupPlan: AgentStartupPlan | null = null
  if (draftLaunchPlan) {
    startupPlan = {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.sessionOptions ? { sessionOptions: draftLaunchPlan.sessionOptions } : {}),
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  } else if (inputs) {
    startupPlan = buildAgentStartupPlan({
      ...inputs,
      prompt,
      allowEmptyPromptLaunch: true
    })
    if (startupPlan && draftPrompt) {
      startupPlan.draftPrompt = draftPrompt
    }
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
  return { startupPlan, backendStartup, telemetry }
}

export async function prepareQuickComposerStartup(
  input: Omit<QuickComposerStartupInput, 'prompt' | 'draftPrompt'> & {
    repoId: string
    executionHostId: ComposerModel['selectedRepoExecutionHostId']
    linkedWorkItem: Parameters<typeof resolveQuickCreateLinkedWorkItemPrompt>[0]
    note: string
  }
): Promise<QuickComposerStartup & { prompt: string; draftPrompt: string | null }> {
  const preferences = input.agent
    ? await ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        repoId: input.repoId,
        executionHostId: input.executionHostId ?? undefined
      })
    : undefined
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(
    input.agent ? input.linkedWorkItem : null,
    input.note
  )
  return {
    prompt,
    draftPrompt,
    ...buildQuickComposerStartup({
      ...input,
      prompt,
      draftPrompt,
      settings: input.settings
        ? {
            ...input.settings,
            agentLaunchChoices: preferences?.agentLaunchChoices ?? input.settings.agentLaunchChoices
          }
        : input.settings
    })
  }
}
