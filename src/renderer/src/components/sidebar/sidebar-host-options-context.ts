import { createContext } from 'react'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'

/** The sidebar's host registry, so menus inside it label hosts without reading the focused host. */
export const SidebarHostOptionsContext = createContext<
  readonly ExecutionHostRegistryEntry[] | null
>(null)
