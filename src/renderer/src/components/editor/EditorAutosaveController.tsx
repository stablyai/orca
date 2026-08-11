import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { attachRestoredTabConflictScan } from './editor-restored-tab-conflict-scan'

export default function EditorAutosaveController(): null {
  useEffect(() => {
    // Why: autosave and quit coordination need to survive editor tab switches,
    // but keeping the full EditorPanel mounted while hidden widened the restart
    // surface too far. Keep only this narrow controller alive between mounts.
    const detachAutosave = attachEditorAutosaveController(useAppStore)
    // Why: restored dirty tabs must be conflict-checked app-level, before any
    // panel mounts — autosave can otherwise write over an offline agent edit.
    const detachConflictScan = attachRestoredTabConflictScan(useAppStore)
    return () => {
      detachAutosave()
      detachConflictScan()
    }
  }, [])

  return null
}
