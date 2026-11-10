import { createContext, useContext, useEffect } from 'react'
import type { AgentPickerInventorySource } from './agent-picker-inventory-source'
import type { AgentPickerSurface } from '../../../../shared/agent-launch/picker/agent-launch-picker'

export const AgentPickerCatalogDemand =
  createContext<AgentPickerInventorySource['observeSurface']>(undefined)

export function useAgentPickerCatalogDemand(
  agent: string,
  surface: AgentPickerSurface,
  open: boolean
) {
  const observe = useContext(AgentPickerCatalogDemand)
  useEffect(() => (open ? observe?.(agent, surface) : undefined), [observe, agent, surface, open])
}
