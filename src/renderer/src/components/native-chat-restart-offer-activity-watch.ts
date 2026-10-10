import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { restartMachineTarget, type RestartMachineKey } from './native-chat-restart-machines'
import { createOfferedChatWatch } from './native-chat-resume-offered-chat-watch'

/** One offered-chat watch per machine, on that machine's own status feed. */

type WatchedOffer = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeCandidate[]
  listedAt: number
}

type Watch = { offer: WatchedOffer; watch: ReturnType<typeof createOfferedChatWatch> }

const watches = new Map<RestartMachineKey, Watch>()

function releaseWatch(machine: RestartMachineKey): void {
  watches.get(machine)?.watch.release()
  watches.delete(machine)
}

export function syncOfferedChatWatch(
  machine: RestartMachineKey,
  offer: WatchedOffer | undefined,
  onActivity: (machine: RestartMachineKey) => void
): void {
  if (!offer || offer.candidates.length + offer.failed.length === 0) {
    releaseWatch(machine)
    return
  }
  let entry = watches.get(machine)
  if (!entry) {
    const created: Watch = {
      offer,
      watch: createOfferedChatWatch({
        feed: () => getStructuredAgentSessionStatusFeed(restartMachineTarget(machine)),
        offeredIds: () =>
          new Set(
            [...created.offer.candidates, ...created.offer.failed].map((row) => row.sessionId)
          ),
        listedAt: () => created.offer.listedAt,
        refresh: () => onActivity(machine)
      })
    }
    watches.set(machine, created)
    entry = created
  }
  entry.offer = offer
  entry.watch.sync()
}

export function releaseOfferedChatWatches(): void {
  for (const machine of watches.keys()) {
    releaseWatch(machine)
  }
}
