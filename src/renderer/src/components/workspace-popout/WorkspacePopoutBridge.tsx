import { useEffect } from 'react'
import { initWorkspacePopoutState } from '@/lib/workspace-popout/workspace-popout-state'

export default function WorkspacePopoutBridge(): null {
  useEffect(() => {
    return initWorkspacePopoutState()
  }, [])
  return null
}
