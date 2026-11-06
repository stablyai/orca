import { useAppStore } from '@/store'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import type { ComposerModel } from './composer-model'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-startup'
import { planQuickAgentStartup } from '../../../../shared/agent-launch/startup/agent-launch-terminal-recipe'

import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
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
  launchInputs?: WorktreeCreationRequest['launchInputs']
  route?: WorktreeCreationRequest['agentLaunchRoute']
}

export type QuickComposerStartup = {
  startupPlan: AgentStartupPlan | null
  /** The planner's own inputs behind `startupPlan`, carried in memory with the request. */
  startupRecipe?: WorktreeCreationRequest['startupRecipe']
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
  const startupPlan = inputs ? planQuickAgentStartup(inputs, prompt, draftPrompt) : null
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
  const startupRecipe = inputs
    ? { inputs, prompt, ...(draftPrompt ? { draftPrompt } : {}) }
    : undefined
  return { startupPlan, ...(startupRecipe ? { startupRecipe } : {}), backendStartup, telemetry }
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
