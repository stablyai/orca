import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE,
  MARKDOWN_DEFAULT_VIEW_MODES,
  type MarkdownDefaultViewMode
} from '../../../../shared/markdown-default-view-mode'

// Why: Monaco's context menu takes flat actions, not a radio submenu. Hiding the
// mode that is already the default keeps every visible entry an action that
// changes something, so no check state has to be faked.
const NOT_ACTIVE_CONTEXT_KEYS: Record<MarkdownDefaultViewMode, string> = {
  source: 'orcaMarkdownDefaultViewNotSource',
  rich: 'orcaMarkdownDefaultViewNotRich',
  preview: 'orcaMarkdownDefaultViewNotPreview'
}

function viewModeLabel(mode: MarkdownDefaultViewMode): string {
  if (mode === 'source') {
    return translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
  }
  if (mode === 'rich') {
    return translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')
  }
  return translate('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')
}

function actionLabel(mode: MarkdownDefaultViewMode): string {
  const prefix = translate(
    'auto.components.settings.MarkdownDefaultViewSetting.2255066e40',
    'Default Markdown View'
  )
  return `${prefix}: ${viewModeLabel(mode)}`
}

/** Adds "Default Markdown View: …" entries to Monaco's context menu on markdown files. */
export function useMonacoMarkdownDefaultViewActions(
  editorInstance: editor.IStandaloneCodeEditor | null,
  language: string
): void {
  const markdownDefaultViewMode = useAppStore((s) => s.settings?.markdownDefaultViewMode)
  const isMarkdown = language === 'markdown'

  useEffect(() => {
    if (!editorInstance || !isMarkdown) {
      return
    }
    const actions = MARKDOWN_DEFAULT_VIEW_MODES.map((mode, index) =>
      editorInstance.addAction({
        id: `orca.markdownDefaultView.${mode}`,
        label: actionLabel(mode),
        precondition: NOT_ACTIVE_CONTEXT_KEYS[mode],
        contextMenuGroupId: 'orca.markdownDefaultView',
        contextMenuOrder: index,
        run: () => {
          void useAppStore.getState().updateSettings({ markdownDefaultViewMode: mode })
        }
      })
    )
    return () => {
      for (const action of actions) {
        action.dispose()
      }
    }
  }, [editorInstance, isMarkdown])

  useEffect(() => {
    if (!editorInstance || !isMarkdown) {
      return
    }
    const active = markdownDefaultViewMode ?? DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE
    // Why re-created per change: Monaco exposes no getter for an existing key, and
    // createContextKey is idempotent apart from the default it immediately overwrites.
    const keys = MARKDOWN_DEFAULT_VIEW_MODES.map((mode) => ({
      mode,
      key: editorInstance.createContextKey<boolean>(NOT_ACTIVE_CONTEXT_KEYS[mode], false)
    }))
    for (const { mode, key } of keys) {
      key.set(mode !== active)
    }
    return () => {
      for (const { key } of keys) {
        key.set(false)
      }
    }
  }, [editorInstance, isMarkdown, markdownDefaultViewMode])
}
