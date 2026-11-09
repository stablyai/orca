import { useCallback, useMemo, useState } from 'react'
import {
  useComposerState,
  type UseComposerStateOptions,
  type UseComposerStateResult
} from '@/hooks/useComposerState'
import {
  sessionOptionsForAgent,
  type PluginTaskSessionOptions
} from '@/lib/plugin-task-session-options'
import type { LinkedPluginTask } from '../../../../shared/plugins/tasks/plugin-task-link'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

/** What a composer opener (a plugin task's start recipe) prefills for the agent launch. */
export type PluginTaskLaunch = {
  /** Editable draft typed into the agent after launch (e.g. a plugin task's prompt). */
  initialAgentDraft?: string
  /** Per-launch agent session options (e.g. model, effort) from the opener. */
  initialAgentSessionOptions?: PluginTaskSessionOptions
  /** Plugin task the new workspace links back to. */
  linkedPluginTask?: LinkedPluginTask
}

type PluginTaskCardProps = Pick<
  NewWorkspaceComposerCardProps,
  'agentDraft' | 'onAgentDraftChange' | 'agentSessionOptions'
>

/** The quick composer with a plugin task's editable prompt, session options and task link. */
export function usePluginTaskComposerState(
  data: PluginTaskLaunch,
  options: UseComposerStateOptions
): UseComposerStateResult & { cardProps: PluginTaskCardProps } {
  const state = useComposerState(options)
  const [agentDraft, setAgentDraft] = useState<string | null>(data.initialAgentDraft ?? null)
  const { initialAgentSessionOptions, linkedPluginTask } = data
  const { submitQuick, cardProps } = state
  const submitWithPluginTask = useCallback<UseComposerStateResult['submitQuick']>(
    (agent, submitOptions) => {
      const sessionOptions = sessionOptionsForAgent(initialAgentSessionOptions, agent)
      const launchInputs = submitOptions?.launchInputs
      return submitQuick(agent, {
        ...submitOptions,
        ...(agentDraft?.trim() ? { agentDraft } : {}),
        // Why both: host-composed launches read only launchInputs; legacy ones read the override.
        ...(sessionOptions
          ? {
              sessionOptions,
              launchInputs: {
                ...launchInputs,
                sessionOptions: { ...sessionOptions, ...launchInputs?.sessionOptions }
              }
            }
          : {}),
        ...(linkedPluginTask ? { linkedPluginTask } : {})
      })
    },
    [submitQuick, initialAgentSessionOptions, agentDraft, linkedPluginTask]
  )
  const pluginCardProps = useMemo(
    () => ({
      ...cardProps,
      agentDraft,
      onAgentDraftChange: setAgentDraft,
      agentSessionOptions: initialAgentSessionOptions
    }),
    [cardProps, agentDraft, initialAgentSessionOptions]
  )
  return { ...state, cardProps: pluginCardProps, submitQuick: submitWithPluginTask }
}
