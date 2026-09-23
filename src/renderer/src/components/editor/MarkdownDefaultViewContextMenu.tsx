import type React from 'react'
import { useAppStore } from '@/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE,
  isMarkdownDefaultViewMode,
  MARKDOWN_DEFAULT_VIEW_MODES,
  type MarkdownDefaultViewMode
} from '../../../../shared/markdown-default-view-mode'

// Why: reuse the editor toggle's catalog keys so the menu reads the same as the
// buttons it configures, in every locale.
function viewModeLabel(mode: MarkdownDefaultViewMode): string {
  if (mode === 'source') {
    return translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
  }
  if (mode === 'rich') {
    return translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')
  }
  return translate('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')
}

/**
 * Right-click affordance for the persisted default Markdown view. Used on the
 * rendered-preview surface, which has no native or Monaco context menu of its own.
 */
export function MarkdownDefaultViewContextMenu({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const markdownDefaultViewMode = useAppStore((s) => s.settings?.markdownDefaultViewMode)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>
          {translate(
            'auto.components.settings.MarkdownDefaultViewSetting.2255066e40',
            'Default Markdown View'
          )}
        </ContextMenuLabel>
        <ContextMenuRadioGroup
          value={markdownDefaultViewMode ?? DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE}
          onValueChange={(value) => {
            if (isMarkdownDefaultViewMode(value)) {
              void updateSettings({ markdownDefaultViewMode: value })
            }
          }}
        >
          {MARKDOWN_DEFAULT_VIEW_MODES.map((mode) => (
            <ContextMenuRadioItem key={mode} value={mode}>
              {viewModeLabel(mode)}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
