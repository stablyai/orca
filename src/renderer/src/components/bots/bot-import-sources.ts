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

/** The first-bot nudge's line: OpenClaw's bots, else Hermes'; the apps with the most users first. */
export function botImportNudge(
  sources: readonly BotImportSource[]
): { label: string; count: number } | null {
  for (const app of ['openclaw', 'hermes'] as const) {
    const count = sources.find((source) => source.app === app)?.bots.length ?? 0
    if (count > 0) {
      return { label: app === 'openclaw' ? 'OpenClaw' : 'Hermes', count }
    }
  }
  return null
}
