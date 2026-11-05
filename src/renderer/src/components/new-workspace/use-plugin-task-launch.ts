import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  describePluginTaskSessionOptions,
  sessionOptionsForAgent,
  type PluginTaskSessionOptions
} from '@/lib/plugin-task-session-options'
import type { LinkedPluginTask } from '../../../../shared/plugins/tasks/plugin-task-link'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'
import type { QuickSubmitOptions } from '@/hooks/composer-state/quick-creation-request'

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
  'agentDraft' | 'onAgentDraftChange' | 'agentDraftUnavailableReason' | 'agentSessionNote'
>

/** The quick composer's plugin-task launch: the editable prompt, session options and task link. */
export function usePluginTaskLaunch(
  data: PluginTaskLaunch,
  quickAgent: TuiAgent | null
): {
  submitOptions: Pick<QuickSubmitOptions, 'agentDraft' | 'sessionOptions' | 'linkedPluginTask'>
  cardProps: (isFolderWorkspaceTarget: boolean) => PluginTaskCardProps
} {
  const [agentDraft, setAgentDraft] = useState<string | null>(data.initialAgentDraft ?? null)
  const { initialAgentSessionOptions, linkedPluginTask } = data
  const submitOptions = useMemo(() => {
    const sessionOptions = sessionOptionsForAgent(initialAgentSessionOptions, quickAgent)
    return {
      ...(agentDraft?.trim() ? { agentDraft } : {}),
      ...(sessionOptions ? { sessionOptions } : {}),
      ...(linkedPluginTask ? { linkedPluginTask } : {})
    }
  }, [agentDraft, initialAgentSessionOptions, linkedPluginTask, quickAgent])
  const cardProps = (isFolderWorkspaceTarget: boolean): PluginTaskCardProps => ({
    agentDraft,
    onAgentDraftChange: setAgentDraft,
    agentDraftUnavailableReason: isFolderWorkspaceTarget
      ? translate(
          'auto.components.NewWorkspaceComposerModal.agentDraftFolderGroup',
          'Folder workspaces do not take an agent prompt, so this one will not be sent.'
        )
      : quickAgent === null
        ? translate(
            'auto.components.NewWorkspaceComposerModal.agentDraftNoAgent',
            'Pick an agent to send this prompt.'
          )
        : null,
    agentSessionNote: describePluginTaskSessionOptions(initialAgentSessionOptions, quickAgent)
  })
  return { submitOptions, cardProps }
}
