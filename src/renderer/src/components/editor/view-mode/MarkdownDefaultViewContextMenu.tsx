import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  normalizeMarkdownDefaultViewMode,
  type MarkdownDefaultViewMode
} from '../../../../../shared/markdown-default-view-mode'

type MarkdownDefaultViewContextMenuProps = {
  /** The tab whose switcher was right-clicked; it follows the newly chosen default. */
  fileId: string
  children: React.ReactNode
}

/** Right-click on a Markdown tab's view switcher to choose the view new Markdown files open in. */
export function MarkdownDefaultViewContextMenu({
  fileId,
  children
}: MarkdownDefaultViewContextMenuProps): React.JSX.Element {
  useTranslation()
  const defaultViewMode = useAppStore((s) =>
    normalizeMarkdownDefaultViewMode(s.settings?.markdownDefaultViewMode)
  )
  const setMarkdownDefaultViewMode = useAppStore((s) => s.setMarkdownDefaultViewMode)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex shrink-0" data-testid="markdown-view-switcher">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>
          {translate(
            'auto.components.editor.MarkdownDefaultViewContextMenu.label',
            'Default Markdown View'
          )}
        </ContextMenuLabel>
        <ContextMenuRadioGroup
          value={defaultViewMode}
          onValueChange={(value) =>
            setMarkdownDefaultViewMode(normalizeMarkdownDefaultViewMode(value), fileId)
          }
        >
          {(['source', 'rich'] as const satisfies readonly MarkdownDefaultViewMode[]).map(
            (mode) => (
              <ContextMenuRadioItem key={mode} value={mode}>
                {mode === 'source'
                  ? translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
                  : translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')}
              </ContextMenuRadioItem>
            )
          )}
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
