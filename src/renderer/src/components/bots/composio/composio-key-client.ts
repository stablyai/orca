// The owner's one Composio key on a bot host, as Settings and a bot's Tools show it.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botHostTarget } from '@/lib/bot-hosts'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { ComposioEventsPlace, ComposioKey } from '../../../../../shared/composio/composio-apps'

// Each host's last answer on where its key's project sends events, so one host's line can name
// the other computer that takes them.
const places = new Map<ExecutionHostId, ComposioEventsPlace | null>()
const listeners = new Set<() => void>()

function notePlace(hostId: ExecutionHostId, place: ComposioEventsPlace | null): void {
  places.set(hostId, place)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null until the host answers; read again on every bots change, as a key change is one. */
export function useComposioKey(hostId: ExecutionHostId): ComposioKey | null {
  const [key, setKey] = useState<ComposioKey | null>(null)
  useEffect(() => {
    let live = true
    // One key per computer, read on that computer's host.
    const read = () =>
      void callRuntimeRpc<ComposioKey>(botHostTarget(hostId), 'bots.composio.key', null).then(
        (answer) => {
          notePlace(hostId, answer.events ?? null)
          if (live) {
            setKey(answer)
          }
        },
        () => live && setKey({ key: 'unreadable', hint: null })
      )
    read()
    const stopListening = onBotsChanged(read, hostId, { kinds: ['settings'] })
    return () => {
      live = false
      stopListening()
    }
  }, [hostId])
  return key
}

/**
 * When the host's key project sends its events away from it while its automations wait on them:
 * the computer here that takes them, or '' for one Orca can't name. Null when they come here.
 * Known for the hosts whose key was read (`useComposioKey`).
 */
export function useComposioEventsHolder(hostId: ExecutionHostId): ExecutionHostId | '' | null {
  const read = (): ExecutionHostId | '' | null => {
    const own = places.get(hostId)
    if (!own?.elsewhere) {
      return null
    }
    for (const [other, place] of places) {
      if (other !== hostId && place?.here && place.project === own.project) {
        return other
      }
    }
    return ''
  }
  return useSyncExternalStore(subscribe, read, read)
}
