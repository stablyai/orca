import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAgentSettingsRowId } from '../agent-settings-navigation'
import { AgentCatalogRow, type AgentCatalogRowViewProps } from './AgentCatalogRow'
import {
  createAgentCatalogRowHost,
  type AgentCatalogRowHost as RowHost
} from './agent-catalog-row-placement'

export function AgentCatalogRowHost({
  registry,
  row
}: {
  registry: Map<string, RowHost>
  row: AgentCatalogRowViewProps
}): React.ReactPortal {
  const [host] = useState(() => {
    const rowHost = createAgentCatalogRowHost()
    rowHost.element.id = getAgentSettingsRowId(row.rowId ?? row.agentId)
    return rowHost
  })
  const key = row.rowId ?? row.agentId
  useLayoutEffect(() => {
    registry.set(key, host)
    return () => {
      registry.delete(key)
      // StrictMode replays layout effects when a keyed row moves; keep its connected host through replay.
      queueMicrotask(() => {
        if (registry.get(key) !== host) {
          host.element.remove()
        }
      })
    }
  }, [host, registry, key])
  return createPortal(<AgentCatalogRow {...row} />, host.element, key)
}
