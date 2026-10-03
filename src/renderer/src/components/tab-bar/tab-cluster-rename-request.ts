import { useEffect } from 'react'

const pendingRenames = new Set<string>()

function renameEventType(worktreeId: string, groupId: string, clusterId: string): string {
  return `orca-rename-tab-cluster:${JSON.stringify([worktreeId, groupId, clusterId])}`
}

export function requestTabClusterRename(
  worktreeId: string,
  groupId: string,
  clusterId: string
): void {
  const eventType = renameEventType(worktreeId, groupId, clusterId)
  pendingRenames.add(eventType)
  window.dispatchEvent(new Event(eventType))
}

export function useTabClusterRenameRequest(
  worktreeId: string,
  groupId: string,
  clusterId: string,
  onRename: () => void
): void {
  const eventType = renameEventType(worktreeId, groupId, clusterId)
  useEffect(() => {
    const consume = (): void => {
      if (pendingRenames.delete(eventType)) {
        onRename()
      }
    }
    window.addEventListener(eventType, consume)
    consume()
    return () => window.removeEventListener(eventType, consume)
  }, [eventType, onRename])
}
