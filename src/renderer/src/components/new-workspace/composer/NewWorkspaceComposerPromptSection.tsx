import React, { useCallback } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  AgentLaunchPromptComposer,
  type AgentLaunchPromptTarget
} from '@/components/agent/AgentLaunchPromptComposer'
import { getRepoMainWorktreeId } from '../../../../../shared/worktree/id'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

import { WORKSPACE_CREATION_PROMPT_SCOPE_KEY } from './workspace-composer-prompt-recovery'
const FALLBACK_PROMPT_AGENT: TuiAgent = 'claude'

type NewWorkspaceComposerPromptSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'quickAgent'
  | 'repoId'
  | 'selectedEphemeralVmRecipeId'
  | 'promptEditorRef'
  | 'onPromptLaunch'
  | 'createDisabled'
> & {
  /** Compact controls rendered under the editor: project, host, agent and send. */
  toolbar: React.ReactNode
}

/**
 * The source checkout file references resolve in.
 * Why: a fresh VM holds no copy of it, so references there would point at nothing.
 */
function useSourceWorktreeId(repoId: string, ephemeralVmRecipeId: string | null): string | null {
  return useAppStore((state) => {
    if (ephemeralVmRecipeId) {
      return null
    }
    const repo = state.repos.find((candidate) => candidate.id === repoId)
    return repo ? getRepoMainWorktreeId(repo) : null
  })
}

/** The workspace's first message, written in the shared launch prompt editor. */
export function NewWorkspaceComposerPromptSection({
  quickAgent,
  repoId,
  selectedEphemeralVmRecipeId = null,
  promptEditorRef,
  onPromptLaunch,
  createDisabled,
  toolbar
}: NewWorkspaceComposerPromptSectionProps): React.JSX.Element {
  const t = useTranslate()
  const defaultTuiAgent = useAppStore((state) => state.settings?.defaultTuiAgent ?? null)
  const worktreeId = useSourceWorktreeId(repoId, selectedEphemeralVmRecipeId)
  // Why: a refused create keeps the draft in the editor, so a disabled create refuses rather than locking typing.
  const launch = useCallback(
    (prompt: string): boolean | Promise<boolean> =>
      !createDisabled && onPromptLaunch ? onPromptLaunch(prompt) : false,
    [createDisabled, onPromptLaunch]
  )
  const target: AgentLaunchPromptTarget = {
    scopeKey: WORKSPACE_CREATION_PROMPT_SCOPE_KEY,
    // Why: Blank Terminal keeps the draft in a disabled editor until an agent is picked again.
    agent: quickAgent ?? defaultTuiAgent ?? FALLBACK_PROMPT_AGENT,
    worktreeId
  }
  return (
    <div
      data-workspace-prompt-input="true"
      role="group"
      aria-label={t('auto.components.NewWorkspaceComposerCard.promptLabel', 'Prompt')}
      // Why: the same frame as the native chat composer, since the prompt becomes its first message.
      className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs"
    >
      <AgentLaunchPromptComposer
        target={target}
        composerRef={promptEditorRef ?? null}
        unavailableHint={
          quickAgent === null
            ? t(
                'auto.components.NewWorkspaceComposerCard.promptPlaceholderNoAgent',
                'Pick an agent to send it a prompt'
              )
            : undefined
        }
        placeholder={t(
          'auto.components.NewWorkspaceComposerCard.promptPlaceholder',
          'What should the agent do in this worktree?'
        )}
        onLaunch={launch}
      />
      <div className="flex items-center gap-1 pt-0.5">{toolbar}</div>
    </div>
  )
}
