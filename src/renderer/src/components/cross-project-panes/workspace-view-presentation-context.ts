import { createContext } from 'react'

export const WorkspaceViewPresentationContext = createContext<{
  paneId: string
  viewId: string
} | null>(null)
