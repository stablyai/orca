// RA-11 resume race: after a cloud Restart reconnects, the pane must sit on the terminal the resume
// ensured. Anything else is the leaf's original launch (a new conversation), which the strip reports.
import { useAppStore } from '@/store'
import {
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'

// How long the pane may take to bind its relaunched terminal before the check gives up (the
// attempt's own timeout reports a pane that never binds).
const BIND_CHECK_MS = 30_000

function paneHandleOf(tabId: string, leafId: string): { ptyId: string; handle: string } | null {
  const ptyId =
    useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
  const parsed = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  return ptyId && parsed ? { ptyId, handle: parsed.handle } : null
}

/** The pane id for `handle` on the same environment as `ptyId` (falls back to `ptyId`). */
export function remotePtyIdWithHandle(ptyId: string, handle: string): string {
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  return environmentId ? toRemoteRuntimePtyId(handle, environmentId) : ptyId
}

/** Once the pane binds a new PTY, check it is `handle`; report anything else. */
export function expectPaneBindsHandle(args: {
  tabId: string
  leafId: string
  replacedPtyId: string
  handle: string
  onMismatch: (boundHandle: string) => void
}): void {
  let done = false
  const check = (): boolean => {
    const bound = paneHandleOf(args.tabId, args.leafId)
    if (!bound || bound.ptyId === args.replacedPtyId) {
      return false
    }
    if (bound.handle !== args.handle) {
      args.onMismatch(bound.handle)
    }
    return true
  }
  if (check()) {
    return
  }
  const finish = (): void => {
    done = true
    unsubscribe()
    clearTimeout(timer)
  }
  const unsubscribe = useAppStore.subscribe(() => {
    if (!done && check()) {
      finish()
    }
  })
  const timer = setTimeout(() => {
    if (!done) {
      finish()
    }
  }, BIND_CHECK_MS)
}
