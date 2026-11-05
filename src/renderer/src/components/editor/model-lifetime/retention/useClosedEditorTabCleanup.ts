import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { attachClosedEditorTabCleanup } from './closed-editor-tab-controller'

export function useClosedEditorTabCleanup(): void {
  useEffect(() => attachClosedEditorTabCleanup(useAppStore), [])
}
