// The bots other apps keep on a computer bots run on, for Import from another app and the first-bot nudge.
import { useEffect, useState } from 'react'
import { botHostTarget } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BotImportSource } from '../../../../shared/bots/bot-import'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

export type BotImportSourcesRead =
  | { status: 'loading' }
  | { status: 'ready'; sources: BotImportSource[] }
  | { status: 'failed' }

export async function readBotImportSources(hostId: ExecutionHostId): Promise<BotImportSource[]> {
  const { sources } = await callRuntimeRpc<{ sources: BotImportSource[] }>(
    botHostTarget(hostId),
    'bots.import.sources',
    {}
  )
  return sources
}

/** Read once each time `enabled` turns on or the host changes, so a dialog opened again sees bots added since. */
export function useBotImportSources(
  enabled: boolean,
  hostId: ExecutionHostId
): BotImportSourcesRead {
  const [read, setRead] = useState<BotImportSourcesRead>({ status: 'loading' })
  useEffect(() => {
    if (!enabled) {
      return
    }
    let live = true
    setRead({ status: 'loading' })
    readBotImportSources(hostId).then(
      (sources) => live && setRead({ status: 'ready', sources }),
      () => live && setRead({ status: 'failed' })
    )
    return () => {
      live = false
    }
  }, [enabled, hostId])
  return read
}
