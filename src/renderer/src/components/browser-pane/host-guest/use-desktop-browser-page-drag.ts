import { useEffect } from 'react'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { registerNativeViewWindowOcclusion } from '@/lib/native-view-occlusion'

/** Route application file drags through the renderer's existing browser drop handler. */
export function useDesktopBrowserPageDrag(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return
    }
    let release: (() => void) | undefined
    const finish = (): void => {
      release?.()
      release = undefined
    }
    const start = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(WORKSPACE_FILE_PATH_MIME)) {
        finish()
        release = registerNativeViewWindowOcclusion()
      }
    }
    window.addEventListener('dragstart', start, true)
    window.addEventListener('dragend', finish, true)
    window.addEventListener('drop', finish, true)
    return () => {
      finish()
      window.removeEventListener('dragstart', start, true)
      window.removeEventListener('dragend', finish, true)
      window.removeEventListener('drop', finish, true)
    }
  }, [active])
}
