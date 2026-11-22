import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { ownBotHost } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { botMentionServer } from './bot-mention-server'

const OwnStatus = z.object({
  hostDescriptor: z.looseObject({ installationId: z.string() }).nullish()
})

// This computer's installation id, read once: a server chat's mentions of agents here name it.
let ownInstallation: Promise<string | null> | null = null

function readOwnInstallation(): Promise<string | null> {
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
    void Promise.all([
      runtimeEnvironmentSupportsCapability(
        environmentId,
        ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY
      ),
      readOwnInstallation()
    ])
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
