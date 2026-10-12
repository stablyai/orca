import React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

export function WorkspaceDeleteConfirmNotice({
  isFolder
}: {
  isFolder: boolean
}): React.JSX.Element {
  const shortcut = useShortcutKeyDetails('workspace.delete')
  return (
    <div
      role="status"
      aria-live="polite"
      data-workspace-delete-confirm=""
      className="mt-1 flex flex-wrap items-center gap-1 pl-2 text-[11px] font-medium text-destructive"
    >
      {translate('auto.components.sidebar.WorkspaceDeleteConfirmNotice.press', 'Press')}
      <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
      {isFolder
        ? translate(
            'auto.components.sidebar.WorkspaceDeleteConfirmNotice.againFolder',
            'again to remove from Orca'
          )
        : translate(
            'auto.components.sidebar.WorkspaceDeleteConfirmNotice.again',
            'again to delete'
          )}
    </div>
  )
}
