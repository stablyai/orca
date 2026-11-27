import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ownBotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { botMentionServer } from './bot-mention-server'
import { serverAsksAgentsHere } from './paired-server-asks-on'

const OwnStatus = z.object({
  hostDescriptor: z.looseObject({ installationId: z.string() }).nullish()
})

// This computer's installation id, read once: a server chat's mentions of agents here name it.
let ownInstallation: Promise<string | null> | null = null

export function readOwnInstallation(): Promise<string | null> {
  ownInstallation ??= callRuntimeRpc(ownBotHost().target, 'status.get', {})
    .then((status) => OwnStatus.safeParse(status).data?.hostDescriptor?.installationId ?? null)
    .catch(() => {
      ownInstallation = null
      return null
    })
  return ownInstallation
}

/** This computer's installation id when the chat runs on a paired server whose agents can message
 *  agents here; null otherwise (a chat here, or a server that can't). */
export function usePairedServerClientInstallation(hostId: ExecutionHostId | null): string | null {
  const environmentId = hostId ? botMentionServer(hostId) : null
  const [read, setRead] = useState<{ environmentId: string; installationId: string | null }>()
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let live = true
    void Promise.all([serverAsksAgentsHere(environmentId), readOwnInstallation()])
      .then(([supported, installationId]) => {
        if (live) {
          setRead({ environmentId, installationId: supported ? installationId : null })
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [environmentId])
  return read && read.environmentId === environmentId ? read.installationId : null
}

/** This computer's installation id once read; null until then. */
export function useOwnInstallation(): string | null {
  const [own, setOwn] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void readOwnInstallation().then((id) => {
      if (live) {
        setOwn(id)
      }
    })
    return () => {
      live = false
    }
  }, [])
  return own
}
