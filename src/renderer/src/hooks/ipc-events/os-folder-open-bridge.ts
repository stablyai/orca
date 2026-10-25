import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

export function registerOsFolderOpenBridge(unsubs: (() => void)[]): void {
  let disposed = false
  let queued: string[] = []
  let scheduled = false
  const drain = (): void => {
    scheduled = false
    if (disposed || queued.length === 0) {
      return
    }
    const store = useAppStore.getState()
    if (!store.workspaceSessionReady || store.activeModal !== 'none') {
      return
    }
    if (store.settings?.activeRuntimeEnvironmentId) {
      queued = []
      toast.error(
        translate(
          'auto.components.sidebar.useAddRepoLocalFolderFlow.7ab10e4974',
          'Use a host path to add projects from a remote host.'
        )
      )
      return
    }
    const path = queued.shift()
    if (path) {
      store.openModal('add-repo', { droppedLocalPath: path })
    }
  }
  const schedule = (): void => {
    if (scheduled || disposed) {
      return
    }
    scheduled = true
    // Defer until modal dismissal finishes before opening the next folder flow.
    queueMicrotask(drain)
  }
  const receive = (paths: string[]): void => {
    if (disposed || !Array.isArray(paths)) {
      return
    }
    for (const path of paths) {
      if (typeof path === 'string' && path && !queued.includes(path)) {
        queued.push(path)
      }
    }
    schedule()
  }
  unsubs.push(() => {
    disposed = true
    queued = []
  })
  unsubs.push(useAppStore.subscribe(schedule))
  const unsubscribe = window.api.ui.onOpenFolders?.(receive)
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }
  const pending = window.api.ui.consumePendingFolderOpens?.()
  if (pending && typeof pending.then === 'function') {
    void pending.then(receive).catch(() => {})
  }
}
