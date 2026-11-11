import { useEffect, useRef } from 'react'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { editorShortcutMatches } from '../../editor-shortcuts'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from '../../editor-panel-content-types'
import { useDiffViewed } from './use-diff-viewed'
import { DiffViewedCheckbox } from './diff-viewed-checkbox'

export function DiffViewedControl({
  file,
  content,
  viewId
}: {
  file: OpenFile
  content?: DiffContent
  viewId?: string | null
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const shortcut = useShortcutKeyDetails('editor.toggleViewed')
  const { viewed, disabled, toggle } = useDiffViewed(file, content, viewId)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        disabled ||
        event.defaultPrevented ||
        event.isComposing ||
        !(target instanceof Element) ||
        !rootRef.current?.closest('[data-editor-panel]')?.contains(target) ||
        (isEditableTarget(target) && !target.matches('.monaco-editor textarea.inputarea')) ||
        !editorShortcutMatches('editor.toggleViewed', event)
      ) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) {
        void toggle()
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [disabled, toggle])
  return (
    <DiffViewedCheckbox
      ref={rootRef}
      viewed={viewed}
      disabled={disabled}
      onToggle={() => void toggle()}
      shortcut={shortcut}
    />
  )
}
