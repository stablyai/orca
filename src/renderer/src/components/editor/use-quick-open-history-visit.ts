import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { recordQuickOpenFileVisit } from '@/lib/quick-open-file-history'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

export function useQuickOpenHistoryVisit(
  file: OpenFile | null,
  content: FileContent | undefined,
  visible: boolean
): void {
  useEffect(() => {
    if (visible && file && content && !content.loadError && !content.isStale) {
      recordQuickOpenFileVisit(useAppStore.getState(), file)
    }
  }, [file, content, visible])
}
