import { useEffect, useRef } from 'react'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  eligibleCustomEditorsForContent,
  type ActivePluginCustomEditor
} from '@/store/plugin-custom-editors'
import type { FileContent } from './editor-panel-content-types'
import {
  reportPluginEditorContent,
  withdrawPluginEditorContent
} from './plugin-editor-capture-status'

export function usePluginEditorContentReport(
  file: OpenFile | null,
  content: FileContent | undefined,
  editors: readonly ActivePluginCustomEditor[]
): void {
  const owner = useRef(Symbol('editor-content')).current
  useEffect(() => {
    if (file) {
      const eligible = eligibleCustomEditorsForContent(file, content, editors)
      reportPluginEditorContent(
        file.id,
        owner,
        content ? eligible.map((editor) => editor.key) : undefined,
        content?.loadError ? { code: 'editor_read_failed', message: content.loadError } : null,
        file.filePath,
        eligible.find((editor) => editor.priority === 'default')?.key ?? null
      )
    }
  }, [file, content, editors, owner])
  const fileId = file?.id
  useEffect(
    () => () => {
      if (fileId) {
        withdrawPluginEditorContent(fileId, owner)
      }
    },
    [fileId, owner]
  )
}
