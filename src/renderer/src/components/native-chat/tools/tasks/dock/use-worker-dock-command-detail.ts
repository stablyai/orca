import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkerDockRowView } from './WorkerDockRow'
import {
  openWorkerDockCommandDetail,
  type WorkerDockCommandDetail
} from './worker-dock-command-detail'

type Holder = { detail: WorkerDockCommandDetail | null; mounted: number; read: boolean }

/** One opening and one read per dialog instance (StrictMode's remount keeps the same one); a lost
 *  opening drops the exact text at once and Copy goes with it. */
export function useWorkerDockCommandDetail(
  held: WorkerDockRowView,
  sessionId: string,
  target: RuntimeClientTarget
): { exact: string | null; copy: () => Promise<boolean> } {
  const holder = useRef<Holder | null>(null)
  const [exact, setExact] = useState<string | null>(null)
  // The held row, session and target as this instance opened; they never retarget while it is up.
  const [opened] = useState(() => ({ tuple: held.commandDetail, sessionId, target }))
  useEffect(() => {
    if (holder.current === null) {
      holder.current = {
        detail: opened.tuple
          ? openWorkerDockCommandDetail({
              sessionId: opened.sessionId,
              target: opened.target,
              tuple: opened.tuple
            })
          : null,
        mounted: 0,
        read: false
      }
    }
    const current = holder.current
    current.mounted += 1
    const live = () => current.mounted > 0
    const stopLost = current.detail?.opening.onLost(() => {
      if (live()) {
        setExact(null)
      }
    })
    if (current.detail && !current.read) {
      current.read = true
      void current.detail.read().then((text) => {
        if (live() && text !== null && current.detail?.opening.valid()) {
          setExact(text)
        }
      })
    }
    return () => {
      stopLost?.()
      current.mounted -= 1
      // StrictMode remounts synchronously; only a real unmount closes the opening.
      queueMicrotask(() => {
        if (current.mounted === 0) {
          current.detail?.close()
        }
      })
    }
  }, [opened])
  const copy = useCallback(async (): Promise<boolean> => {
    const detail = holder.current?.detail
    if (!detail) {
      return false
    }
    const wrote = await detail.copy((text) => window.api.ui.writeClipboardText(text))
    if (!wrote) {
      setExact(null)
    }
    return wrote
  }, [])
  return { exact, copy }
}
