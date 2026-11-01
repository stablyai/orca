import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { discoverRuntimeCommitMessageModels } from '@/runtime/runtime-git-generation-client'
import { getCommitMessageAgentCapability } from '../../../../shared/commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/commit-message-host-key'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import {
  getDiscoveredModels,
  withDiscoveredModels
} from '../../../../shared/source-control-ai-model-selection'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

// One listing per agent at a time, however many cards open their picker.
const pending = new Map<TuiAgent, Promise<void>>()

function listTextModels(
  agent: TuiAgent,
  hostKey: string,
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
): Promise<void> {
  return discoverRuntimeCommitMessageModels(
    {
      target: { kind: 'local' },
      prefs: useAppStore.getState().settings,
      worktreeId: null,
      worktreePath: ''
    },
    agent
  )
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

/** Ask this machine's CLI for its text models when a picker opens; the saved list feeds the menu. */
export function useTextActionModelDiscovery(
  hostKey: string,
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
      // Only the local CLI is reachable without a workspace; other hosts keep their saved list.
      if (
        !writeSourceControlAiSettings ||
        hostKey !== LOCAL_COMMIT_MESSAGE_HOST_KEY ||
        getCommitMessageAgentCapability(agent)?.modelSource !== 'dynamic'
      ) {
        return
      }
      let run = pending.get(agent)
      if (!run) {
        run = listTextModels(agent, hostKey, writeSourceControlAiSettings).finally(() =>
          pending.delete(agent)
        )
        pending.set(agent, run)
      }
      setListing(agent)
      void run.then(() => {
        if (mounted.current) {
          setListing((current) => (current === agent ? null : current))
        }
      })
    },
    [hostKey, writeSourceControlAiSettings]
  )
  return { listing, discover }
}
