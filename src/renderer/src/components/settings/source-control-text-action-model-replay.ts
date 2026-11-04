import { useAppStore } from '@/store'
import { getIndexedReposById } from '@/store/worktree-repo-index'
import { getRepoCommitMessageModelDiscoveryHostKey } from '../../../../shared/commit-message-host-key'
import {
  replaySourceControlAiModelEdits,
  type SourceControlAiModelEdits
} from '../../../../shared/source-control-ai-action-model-edits'
import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import type {
  AiTextOperation,
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'

/** The hosts a global text pick covers: every registered repository's, read when called. */
export function registeredRepoTextModelHostKeys(): string[] {
  return useAppStore.getState().repos.map((repo) => getRepoCommitMessageModelDiscoveryHostKey(repo))
}

/** Replay a global card's menu edits inside its queued write, against the hosts registered now. */
export function replayGlobalTextModelEdits(
  current: SourceControlAiSettings,
  actionId: AiTextOperation,
  edits: SourceControlAiModelEdits
): SourceControlAiModelChoice | undefined {
  return replaySourceControlAiModelEdits({
    target: { type: 'global' },
    settings: {
      sourceControlAi: current,
      commitMessageAi: useAppStore.getState().settings?.commitMessageAi
    },
    actionId,
    edits,
    hostKeys: registeredRepoTextModelHostKeys()
  })
}

/** Replay a repository card's menu edits inside its queued write, against the repository's host
 *  now; without edits the saved model stays. */
export function withRepoTextModelEdits(
  base: RepoSourceControlAiOverrides,
  repoId: string,
  actionId: SourceControlActionId,
  edits: SourceControlAiModelEdits | undefined
): RepoSourceControlAiOverrides {
  const textAction = SOURCE_CONTROL_TEXT_ACTION_IDS.find((id) => id === actionId)
  if (!textAction || !edits?.length) {
    return base
  }
  const state = useAppStore.getState()
  const repo = getIndexedReposById(state.repos, repoId)[0]
  const modelChoice = replaySourceControlAiModelEdits({
    target: { type: 'repo', repoId },
    settings: state.settings ?? {},
    repo: { sourceControlAi: base },
    actionId: textAction,
    edits,
    hostKeys: repo ? [getRepoCommitMessageModelDiscoveryHostKey(repo)] : []
  })
  return {
    ...base,
    modelOverridesByOperation: { ...base.modelOverridesByOperation, [textAction]: modelChoice }
  }
}
