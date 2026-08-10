import { Suspense } from 'react'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import type { AgentMapProjectContextMenuRequest } from './AgentMapProjectContextMenu'

const AgentMapProjectContextMenu = lazyWithRetry(
  () =>
    import('./AgentMapProjectContextMenu').then((module) => ({
      default: module.AgentMapProjectContextMenu
    })),
  { reloadKey: 'agent-map-project-context-menu' }
)

type AgentMapProjectContextMenuLoaderProps = {
  request: AgentMapProjectContextMenuRequest
  onOpenChange?: (open: boolean) => void
}

export function AgentMapProjectContextMenuLoader({
  request,
  onOpenChange
}: AgentMapProjectContextMenuLoaderProps): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <AgentMapProjectContextMenu request={request} onOpenChange={onOpenChange} />
    </Suspense>
  )
}

export type { AgentMapProjectContextMenuRequest }
