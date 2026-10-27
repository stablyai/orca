import { useEffect, useState } from 'react'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'

export function useResourceViewVisible(): boolean {
  const [nativeVisible, setNativeVisible] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(getWindowParkVisible)
  useEffect(() => {
    let disposed = false
    let revision = 0
    const unsubscribe = window.api.memory.onResourceWindowVisibility((visible) => {
      revision++
      setNativeVisible(visible)
    })
    const initialRevision = revision
    void window.api.memory
      .resourceWindowVisible()
      .then((visible) => {
        if (!disposed && revision === initialRevision) {
          setNativeVisible(visible)
        }
      })
      .catch(() => {})
    const unsubscribeDocument = subscribeWindowParkVisibility(() =>
      setDocumentVisible(getWindowParkVisible())
    )
    return () => {
      disposed = true
      unsubscribe()
      unsubscribeDocument()
    }
  }, [])
  return nativeVisible && documentVisible
}
