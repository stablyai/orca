import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectWorkspaceWindowMetadata } from '@/store/workspace-window-metadata-selector'

export function WorkspaceWindowMetadataSyncGate(): null {
  const metadata = useAppStore(useShallow(selectWorkspaceWindowMetadata))

  useEffect(() => {
    window.api.ui.setWorkspaceWindowMetadata(metadata)
  }, [metadata])

  return null
}
