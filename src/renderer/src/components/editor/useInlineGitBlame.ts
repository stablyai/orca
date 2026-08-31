import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { formatBlameRelativeTime } from '@/lib/line-blame-format'
import { useLineBlame } from '@/lib/use-line-blame'
import {
  InlineBlameWidget,
  inlineBlameLabelFor,
  inlineBlamePosition
} from './monaco-inline-blame-decoration'

/**
 * Paint the cursor line's authorship at the end of that line, GitLens style.
 *
 * Shares `useLineBlame` with the status-bar segment, so enabling both surfaces
 * still runs one debounced, single-flight `git blame` per resting cursor line.
 */
export function useInlineGitBlame(
  mountedEditor: editor.IStandaloneCodeEditor | null,
  editable: boolean
): void {
  const settingEnabled = useAppStore((s) => s.settings?.editorInlineBlameEnabled !== false)
  const enabled = editable && settingEnabled
  const { blame, line } = useLineBlame(enabled)
  const widgetRef = useRef<InlineBlameWidget | null>(null)

  // Why: the widget belongs to one editor instance; a remount must not keep
  // adding annotations to an editor that is gone.
  useEffect(() => {
    if (!mountedEditor) {
      return
    }
    const widget = new InlineBlameWidget(mountedEditor)
    widgetRef.current = widget
    return () => {
      widget.dispose()
      widgetRef.current = null
    }
  }, [mountedEditor])

  useEffect(() => {
    const widget = widgetRef.current
    const model = mountedEditor?.getModel() ?? null
    if (!widget) {
      return
    }
    if (!enabled || !blame || !line || !model) {
      widget.hide()
      return
    }
    const position = inlineBlamePosition(model, line)
    if (!position) {
      widget.hide()
      return
    }
    widget.show(
      inlineBlameLabelFor({
        blame,
        relativeDate: formatBlameRelativeTime(blame.authorTimeMs),
        uncommittedLabel: translate(
          'auto.components.editor.useInlineGitBlame.uncommitted',
          'Uncommitted changes'
        )
      }),
      position
    )
  }, [blame, enabled, line, mountedEditor])
}
