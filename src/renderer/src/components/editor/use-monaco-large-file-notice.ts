import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { editor } from 'monaco-editor'
import { translate } from '@/i18n/i18n'
import { readMonacoLargeFileOptimizations } from './monaco-large-file-optimizations'

const LARGE_FILE_NOTICE_DURATION_MS = 12_000

/**
 * Tells the user why a large file lost tokenization, folding, wrapping, code
 * lenses, sticky scroll and word highlighting. Fires only when the model itself
 * reports the degradation — an unreadable flag stays silent rather than guessing.
 */
export function useMonacoLargeFileNotice(
  mountedEditor: editor.IStandaloneCodeEditor | null,
  filePath: string
): void {
  const noticedPathsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!mountedEditor || noticedPathsRef.current.has(filePath)) {
      return
    }
    if (readMonacoLargeFileOptimizations(mountedEditor.getModel()) !== 'applied') {
      return
    }
    noticedPathsRef.current.add(filePath)
    toast(
      translate(
        'auto.components.editor.MonacoEditor.largeFileOptimizations',
        'Large file: syntax highlighting, folding and word wrap are off'
      ),
      {
        description: translate(
          'auto.components.editor.MonacoEditor.largeFileOptimizationsDescription',
          'The editor disables these on very large files to avoid freezing. Editing and search still work.'
        ),
        duration: LARGE_FILE_NOTICE_DURATION_MS
      }
    )
  }, [mountedEditor, filePath])
}
