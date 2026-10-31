import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useEffect } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useAppStore } from '@/store'

type ActionAgent = { status: 'pending' } | { status: 'ready'; agent: TuiAgent | null }

export function useSourceControlActionAgentInventory(enabled = true): void {
  const ensure = useAppStore((state) => state.ensureNativeDetectedAgents)
  useEffect(() => {
    if (enabled) {
      void ensure()
    }
  }, [enabled, ensure])
}

/** The agent an action launches; pending until detection says which agents can run. */
export function useSourceControlActionAgent(
  selected: SourceControlActionRecipe['agentId'],
  defaultAgent: GlobalSettings['defaultTuiAgent']
): ActionAgent & { resolve: (agent: SourceControlActionRecipe['agentId']) => ActionAgent } {
  const disabledAgents = useAppStore((state) => state.settings?.disabledTuiAgents)
  const detected = useAppStore(readNativeDetectedAgents)
  const failed = useAppStore(
    (state) => state.readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID).state === 'failed'
  )
  const resolve = (selected: SourceControlActionRecipe['agentId']): ActionAgent =>
    detected === null && !failed
      ? { status: 'pending' }
      : {
          status: 'ready',
          agent: pickSourceControlLaunchAgent({
            savedAgent: selected && !isCustomAgentId(selected) ? selected : null,
            defaultAgent,
            detectedAgents: detected ?? [],
            disabledAgents
          })
        }
  return { ...resolve(selected), resolve }
}
