import { useEffect, useRef } from 'react'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { retryAgentPickerCatalog } from './agent-launch-picker-acquisition'

/** Only the visible setup may start dima's persistent daemon on a cold read. */
export function useSetupModelListing(entry: AgentPickerEntry): () => void {
  const requested = useRef<string | undefined>(undefined)
  const { agent, ownerKey, catalogRead } = entry
  useEffect(() => {
    if (agent !== 'dima' || !ownerKey || catalogRead === undefined) {
      requested.current = undefined
      return
    }
    // A seed has no acquisition yet. Its first settled publication proves where to send the read.
    if (catalogRead === 'settled' && requested.current !== ownerKey) {
      requested.current = ownerKey
      retryAgentPickerCatalog(ownerKey, agent, true)
    }
  }, [agent, ownerKey, catalogRead])

  return () => {
    if (ownerKey) {
      retryAgentPickerCatalog(ownerKey, agent)
    }
  }
}
