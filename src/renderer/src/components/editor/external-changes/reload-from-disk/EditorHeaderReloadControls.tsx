import { useCallback, useEffect, useState, type RefObject } from 'react'
import { RefreshCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { EditorReloadFromDiskButton } from './EditorReloadFromDiskButton'
import { isEditorReloadEligible } from './editor-reload-tab-state'
import { useEditorReloadInFlight } from './editor-reload-in-flight'
import { useEditorFileWatchPaused } from './useEditorPanelReloadFromDisk'
import type { EditorReloadUi } from './editor-reload-from-disk-feedback'

/** Announcements fade so a later identical message is read again. */
const RELOAD_STATUS_CLEAR_MS = 3_000

/** Marks the header's "…" trigger, where focus goes if the reload icon disappears under it. */
export const EDITOR_ACTIONS_TRIGGER_ATTR = 'data-editor-actions-trigger'

/** The header's Reload from Disk icon (with its status region) and its "…" menu item. */
export function useEditorHeaderReloadControls(
  activeFile: OpenFile,
  headerRef: RefObject<HTMLDivElement | null>,
  onReloadFromDisk: ((ui?: EditorReloadUi) => void) | undefined
): { headerControls: React.ReactNode; menuItem: React.ReactNode } {
  const t = useTranslate()
  // Edit and Markdown preview tabs in every view (incl. Changes), so the icon never shifts the toggle.
  const canReload = onReloadFromDisk !== undefined && isEditorReloadEligible(activeFile)
  const paused = useEditorFileWatchPaused(canReload ? activeFile : null)
  const busy = useEditorReloadInFlight(activeFile.id).busy
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!status) {
      return
    }
    const timer = setTimeout(() => setStatus(''), RELOAD_STATUS_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [status])
  const reload = useCallback(
    () =>
      onReloadFromDisk?.({
        announce: setStatus,
        // The header's panel also holds this tab's conflict banner.
        focusScope: headerRef.current?.parentElement ?? null
      }),
    [headerRef, onReloadFromDisk]
  )
  const fileId = activeFile.id
  // The reload found the file gone and the tab turned into its deleted state; the outcome announces it.
  const handleLoseFocus = useCallback(() => {
    headerRef.current?.querySelector<HTMLElement>(`[${EDITOR_ACTIONS_TRIGGER_ATTR}]`)?.focus()
  }, [headerRef])

  const headerControls = (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {status}
      </span>
      {canReload ? (
        <EditorReloadFromDiskButton
          fileId={fileId}
          paused={paused}
          onReload={reload}
          onLoseFocus={handleLoseFocus}
        />
      ) : null}
    </>
  )
  const menuItem = canReload ? (
    <DropdownMenuItem disabled={busy} onSelect={reload}>
      <RefreshCw />
      {t('auto.components.editor.ExternalFileChangeBanner.3fa2b8d417', 'Reload from Disk')}
    </DropdownMenuItem>
  ) : undefined
  return { headerControls, menuItem }
}
