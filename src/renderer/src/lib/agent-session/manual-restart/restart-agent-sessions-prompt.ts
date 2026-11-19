/** The Restart agent sessions dialog's state: scan local agent panes, ask, then restart and report what really restarted. */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  localAgentRestartCandidates,
  type AgentRestartCandidate
} from './local-agent-restart-candidates'
import { trackManualAgentRestarts, type ManualRestartOutcome } from './manual-agent-restart-outcome'

export type RestartAgentSessionsPrompt = {
  id: number
  candidates: AgentRestartCandidate[]
}

type RestartableCandidate = Extract<AgentRestartCandidate, { restartable: true }>

let scanGeneration = 0
let scanning = false
let prompt: RestartAgentSessionsPrompt | null = null
const promptListeners = new Set<() => void>()

function setPrompt(next: RestartAgentSessionsPrompt | null): void {
  prompt = next
  for (const listener of promptListeners) {
    listener()
  }
}

export function getRestartAgentSessionsPrompt(): RestartAgentSessionsPrompt | null {
  return prompt
}

export function subscribeRestartAgentSessionsPrompt(listener: () => void): () => void {
  promptListeners.add(listener)
  return () => promptListeners.delete(listener)
}

/** Only sessions that look finished start ticked, so a busy one is never stopped by accident. */
export function isCheckedByDefault(candidate: AgentRestartCandidate): boolean {
  return candidate.restartable && candidate.quiet
}

export async function openRestartAgentSessionsPrompt(): Promise<void> {
  // Why: a second run while scanning or asking would stack a second dialog.
  if (scanning || prompt) {
    return
  }
  scanning = true
  const generation = ++scanGeneration
  // Why a toast: a slow remote host can hold the scan for about 10 seconds.
  const scanToast = toast.loading(
    translate('agentSessionRestart.scanning', 'Looking for agent sessions…')
  )
  let candidates: AgentRestartCandidate[]
  try {
    candidates = await localAgentRestartCandidates(useAppStore.getState())
  } catch (error) {
    toast.dismiss(scanToast)
    throw error
  } finally {
    scanning = false
  }
  if (generation !== scanGeneration) {
    toast.dismiss(scanToast)
    return
  }
  if (candidates.length === 0) {
    toast.info(translate('agentSessionRestart.none', 'No agent sessions to restart.'), {
      id: scanToast
    })
    return
  }
  toast.dismiss(scanToast)
  setPrompt({ id: generation, candidates })
}

/** Restarts the ticked sessions; without `ptyIds`, the ones ticked by default. */
export function answerRestartAgentSessionsPrompt(
  answer: 'restart' | 'cancel',
  ptyIds?: readonly string[]
): void {
  const request = prompt
  if (!request) {
    return
  }
  setPrompt(null)
  if (answer === 'cancel') {
    return
  }
  // Why filtered: only restartable sessions this dialog listed may restart.
  const picked = request.candidates.filter(
    (candidate): candidate is RestartableCandidate =>
      candidate.restartable &&
      (ptyIds ? ptyIds.includes(candidate.ptyId) : isCheckedByDefault(candidate))
  )
  if (picked.length === 0) {
    return
  }
  // Why now: a reattach can rebind a pane while the dialog is open, and a closed pane has none.
  const layouts = useAppStore.getState().terminalLayoutsByTabId
  const panes = picked.flatMap(({ tabId, leafId, agent }) => {
    const ptyId = layouts[tabId]?.ptyIdsByLeafId?.[leafId]
    return ptyId ? [{ tabId, leafId, ptyId, agent }] : []
  })
  useAppStore.getState().queuePaneManualRestarts(panes)
  // Why no await before tracking: a reattach rotation in between would count as a restart.
  const closed = picked.length - panes.length
  void trackManualAgentRestarts(panes).then((outcome) =>
    announceRestartOutcome({ ...outcome, failed: outcome.failed + closed })
  )
}

function announceRestartOutcome({ restarted, failed }: ManualRestartOutcome): void {
  if (failed === 0) {
    toast.success(
      translate('agentSessionRestart.restarted', 'Restarted {{count}} agent sessions.', {
        count: restarted,
        defaultValue_one: 'Restarted {{count}} agent session.'
      })
    )
    return
  }
  toast.warning(
    translate(
      'agentSessionRestart.partlyRestarted',
      "Restarted {{restarted}} of {{count}} agent sessions. {{failed}} couldn't restart.",
      {
        count: restarted + failed,
        restarted,
        failed,
        defaultValue_one:
          "Restarted {{restarted}} of {{count}} agent session. {{failed}} couldn't restart."
      }
    )
  )
}
