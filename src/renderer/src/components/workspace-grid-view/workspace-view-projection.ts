import { createContext, useContext } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import type { WorkspaceViewPanel } from '@/lib/workspace-view-layout'

export type WorkspaceViewPlacement = {
  panel: WorkspaceViewPanel
  tab: Tab
  visible: boolean
  focused: boolean
}
export const WorkspaceViewProjection = createContext<readonly WorkspaceViewPlacement[] | null>(null)
export const useWorkspaceViewProjection = () => useContext(WorkspaceViewProjection)
