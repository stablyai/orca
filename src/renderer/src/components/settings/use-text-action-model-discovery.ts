import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { discoverRuntimeCommitMessageModels } from '@/runtime/runtime-git-generation-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { resolveWorktreeModelDiscoveryRuntime } from '../native-chat/native-chat-session-option-discovery'
import { getCommitMessageAgentCapability } from '../../../../shared/commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/commit-message-host-key'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import {
  getDiscoveredModels,
  withDiscoveredModels
} from '../../../../shared/source-control-ai-model-selection'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

// One listing per host and agent at a time, however many cards open their picker.
const pending = new Map<string, Promise<void>>()

/** This machine is asked directly; a repository's host is asked through one of its worktrees. */
function discoveryContext(hostKey: string, repoId: string | undefined): RuntimeGitContext | null {
  const state = useAppStore.getState()
  if (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY) {
    return { target: { kind: 'local' }, prefs: state.settings, worktreeId: null, worktreePath: '' }
  }
  const worktree = repoId ? state.worktreesByRepo[repoId]?.[0] : undefined
  return worktree ? resolveWorktreeModelDiscoveryRuntime(state, worktree.id) : null
}

function listTextModels(
  agent: TuiAgent,
  hostKey: string,
  context: RuntimeGitContext,
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
): Promise<void> {
  return discoverRuntimeCommitMessageModels(context, agent)
    .then((result) => {
      const settings = useAppStore.getState().settings
      if (!result.success || !result.models.length || !settings) {
        return
      }
      const saved = getDiscoveredModels(
        normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi),
        settings.commitMessageAi,
        hostKey,
        agent
      )
      if (JSON.stringify(saved) === JSON.stringify(result.models)) {
        return
      }
      return writeSourceControlAiSettings((current) =>
        withDiscoveredModels(current, agent, result.models, hostKey)
      )
    })
    .catch(() => undefined)
}

/** Ask the card's host CLI for its text models when a picker opens; the saved list feeds the menu. */
export function useTextActionModelDiscovery(
  hostKey: string,
  repoId: string | undefined,
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
): { listing: TuiAgent | null; discover: (agent: TuiAgent) => void } {
  const [listing, setListing] = useState<TuiAgent | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const discover = useCallback(
    (agent: TuiAgent) => {
      if (
        !writeSourceControlAiSettings ||
        getCommitMessageAgentCapability(agent)?.modelSource !== 'dynamic'
      ) {
        return
      }
      const key = `${hostKey} ${agent}`
      let run = pending.get(key)
      if (!run) {
        // A repository with no worktree has nothing to ask through, so it keeps its saved list.
        const context = discoveryContext(hostKey, repoId)
        if (!context) {
          return
        }
        run = listTextModels(agent, hostKey, context, writeSourceControlAiSettings).finally(() =>
          pending.delete(key)
        )
        pending.set(key, run)
      }
      setListing(agent)
      void run.then(() => {
        if (mounted.current) {
          setListing((current) => (current === agent ? null : current))
        }
      })
    },
    [hostKey, repoId, writeSourceControlAiSettings]
  )
  return { listing, discover }
}
