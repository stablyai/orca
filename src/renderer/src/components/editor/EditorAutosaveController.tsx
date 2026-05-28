import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { attachEditorAutosaveController } from './editor-autosave-controller'

export default function EditorAutosaveController(): null {
  useEffect(() => {
    // Why: autosave and quit coordination need to survive editor tab switches,
    // but keeping the full EditorPanel mounted while hidden widened the restart
    // surface too far. Keep only this narrow controller alive between mounts.
    return attachEditorAutosaveController(useAppStore)
  }, [])

  return null
}
