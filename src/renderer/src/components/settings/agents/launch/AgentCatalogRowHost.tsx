import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { getAgentSettingsRowId } from '../agents-search'
import { AgentCatalogRow, type AgentCatalogRowViewProps } from './AgentCatalogRow'
import {
  createAgentCatalogRowHost,
  type AgentCatalogRowHost as RowHost
} from './agent-catalog-row-placement'

export function AgentCatalogRowHost({
  registry,
  row
}: {
  registry: Map<TuiAgent, RowHost>
  row: AgentCatalogRowViewProps
}): React.ReactPortal {
  const [host] = useState(() => {
    const rowHost = createAgentCatalogRowHost()
    rowHost.element.id = getAgentSettingsRowId(row.agentId)
    return rowHost
  })
  useLayoutEffect(() => {
    registry.set(row.agentId, host)
    return () => {
      registry.delete(row.agentId)
      // StrictMode replays layout effects when a keyed row moves; keep its connected host through replay.
      queueMicrotask(() => {
        if (registry.get(row.agentId) !== host) {
          host.element.remove()
        }
      })
    }
  }, [host, registry, row.agentId])
  return createPortal(<AgentCatalogRow {...row} />, host.element, row.agentId)
}
