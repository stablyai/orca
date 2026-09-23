import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE,
  type MarkdownDefaultViewMode
} from '../../../../shared/markdown-default-view-mode'
import { markdownDefaultViewForCommand } from '../../../../shared/rich-markdown-context-menu'

/**
 * Owns the default-Markdown-view preference at app level: mirrors it into main so
 * the native editor context menu can check the active radio item, and applies the
 * commands that menu sends back. App-level so a split pane can't apply one twice.
 */
export function useMarkdownDefaultViewPreference(): void {
  const markdownDefaultViewMode = useAppStore((s) => s.settings?.markdownDefaultViewMode)
  const settingsHydrated = useAppStore((s) => s.settings !== null)

  useEffect(() => {
    if (!settingsHydrated) {
      return
    }
    window.api.ui.setMarkdownDefaultViewMode(
      markdownDefaultViewMode ?? DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE
    )
  }, [markdownDefaultViewMode, settingsHydrated])

  useEffect(() => {
    return window.api.ui.onRichMarkdownContextCommand((payload) => {
      const mode: MarkdownDefaultViewMode | null = markdownDefaultViewForCommand(payload.command)
      if (!mode) {
        return
      }
      void useAppStore.getState().updateSettings({ markdownDefaultViewMode: mode })
    })
  }, [])
}
