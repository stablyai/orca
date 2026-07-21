import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { setPetBoundSession } from './pet-bound-session'

/**
 * The pet's assistant arm.
 *
 * Hard-coded rather than read from settings because this is the mesh's standing
 * decision, recorded in plans/HANDOFF.md: LFM2.5-8B is the assistant default —
 * it ties gemma-4-12B on latency (12.7s vs 12.6s) but wins on context (128K) and
 * is already the voice arm, so speak-back and the pet answer from one model.
 * Never cloud, and never Ternary-Bonsai, which is 64–76s and depth-only.
 */
export const PET_OMP_MODEL = 'mesh-litellm/LFM2.5-8B-A1B-Q4_0.gguf'

/**
 * CLI arguments for a pet-spawned omp session.
 *
 * `--approval-mode always-ask` is deliberate and non-negotiable for a pet: it
 * can open ssh endpoints and browser panels, so it is a real actor and every
 * action should be confirmable. Surfacing those approvals on the bubble is the
 * next step; until then they surface in the pane itself, which is why this
 * spawns a visible pane rather than a headless session.
 *
 * Note what is NOT here: `--session-dir`/`--resume` (a per-pet long-lived
 * thread) and `--mode rpc`. A pane-hosted omp is what makes agent status free —
 * Orca auto-detects the omp executable and injects its status extension, gated
 * on ORCA_PANE_KEY, which a session we spawned ourselves would never satisfy.
 * Binding a durable session dir on top of the pane is a follow-up, not a
 * reason to leave the pane.
 */
export function buildPetOmpAgentArgs(model: string = PET_OMP_MODEL): string {
  return `--approval-mode always-ask --model ${model}`
}

/**
 * Right-click → spawn the pet an assistant.
 *
 * Routed through `launchAgentInNewTab` rather than a hand-built terminal
 * command: that path already resolves the launch platform for SSH/WSL/remote
 * repos, records agent telemetry, and registers the tab's `launchAgent` so the
 * new pane is recognized as an agent session rather than a bare shell.
 *
 * Returns a null spawn when there is no active worktree — an agent has to be
 * launched *somewhere*, and silently picking a repo the user is not looking at
 * would be worse than not offering the row.
 */
export function usePetAgentSpawn(): {
  canSpawn: boolean
  spawnOmpAgent: () => void
} {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)

  const spawnOmpAgent = useCallback((): void => {
    if (!activeWorktreeId) {
      return
    }
    try {
      const result = launchAgentInNewTab({
        agent: 'omp',
        worktreeId: activeWorktreeId,
        agentArgs: buildPetOmpAgentArgs(),
        launchSource: 'pet'
      })
      // Why bind here and not from agent status: an omp pane reports `agents:
      // []` until its first prompt, so a pet that waited for status would spawn
      // an assistant and then still have nothing to say to it. Binding the tab
      // we just created is what makes the pet askable immediately.
      if (result?.tabId) {
        setPetBoundSession({ tabId: result.tabId, worktreeId: activeWorktreeId })
      }
    } catch (error) {
      // Why surface rather than swallow: the pet is a 48px sprite with no
      // status line of its own, so a failed spawn would otherwise look exactly
      // like a click that did nothing — the same failure mode that made the
      // no-target menu look broken.
      toast.error(String(error instanceof Error ? error.message : error))
    }
  }, [activeWorktreeId])

  return { canSpawn: Boolean(activeWorktreeId), spawnOmpAgent }
}
