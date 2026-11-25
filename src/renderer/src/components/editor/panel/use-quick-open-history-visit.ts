import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { recordQuickOpenFileVisit } from '@/lib/files/search/quick-open-file-history'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileContent } from '../loading/editor-panel-content-types'

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
