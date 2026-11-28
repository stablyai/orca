import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'
import { getConnectionIdForFileFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  USER_RETRY,
  type FileContent,
  type ReloadContentOptions
} from '../../loading/editor-panel-content-types'
import { reloadEditorFileFromDisk } from './editor-reload-from-disk'
import { isEditorReloadEligible } from './editor-reload-tab-state'
import { runEditorReloadFromDisk, type EditorReloadUi } from './editor-reload-from-disk-feedback'
import { isEditorReloadInFlight, watchExplicitReloads } from './editor-reload-in-flight'
import { isLocalFileWatchPaused, useLocalFileWatchPaused } from './editor-watch-pause-store'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'

export const ORCA_EDITOR_REQUEST_RELOAD_FROM_DISK_EVENT = 'orca:editor-request-reload-from-disk'

export type EditorRequestReloadFromDiskDetail = { fileId: string; claim: () => void }

/** Reveal/focus checks run only while auto-reload is paused; this keeps a burst of focus events to one read. */
const PAUSED_CHECK_DEBOUNCE_MS = 500

/** The file's path when a local watch serves it; null for SSH / paired-runtime files, which never report a pause. */
function localWatchedFilePath(state: AppState, file: OpenFile | null | undefined): string | null {
  if (!file || file.runtimeEnvironmentId?.trim() || file.externalSshTargetId) {
    return null
  }
  // Only a resolved local owner (null); undefined means the owner hasn't hydrated and may be remote.
  return getConnectionIdForFileFromState(state, file.worktreeId, file.filePath) === null
    ? file.filePath
    : null
}

export function useEditorFileWatchPaused(file: OpenFile | null): boolean {
  const filePath = useAppStore((state) => localWatchedFilePath(state, file))
  return useLocalFileWatchPaused(filePath)
}

function isReloadRequestDetail(value: unknown): value is EditorRequestReloadFromDiskDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileId' in value &&
    typeof value.fileId === 'string' &&
    'claim' in value &&
    typeof value.claim === 'function'
  )
}

/** Palette entry point: asks the panel showing the file to reload it; falls back to no shown content. */
export function requestEditorReloadFromDisk(fileId: string): void {
  let claimed = false
  window.dispatchEvent(
    new CustomEvent<EditorRequestReloadFromDiskDetail>(ORCA_EDITOR_REQUEST_RELOAD_FROM_DISK_EVENT, {
      detail: {
        fileId,
        claim: () => {
          claimed = true
        }
      }
    })
  )
  if (!claimed) {
    void runEditorReloadFromDisk(fileId, () => undefined)
  }
}

type UseEditorPanelReloadFromDiskArgs = {
  activeFile: OpenFile | null
  fileContents: Record<string, FileContent>
  reloadContent: (file: OpenFile, options?: ReloadContentOptions) => void
  isVisible: boolean
}

export function useEditorPanelReloadFromDisk({
  activeFile,
  fileContents,
  reloadContent,
  isVisible
}: UseEditorPanelReloadFromDiskArgs): {
  reloadFromDisk: (ui?: EditorReloadUi) => void
} {
  const fileContentsRef = useRef(fileContents)
  const reloadContentRef = useRef(reloadContent)
  useEffect(() => {
    fileContentsRef.current = fileContents
    reloadContentRef.current = reloadContent
  })
  const activeFileId = activeFile?.id ?? null
  const eligible = activeFile ? isEditorReloadEligible(activeFile) : false

  const reloadFromDisk = useCallback(
    (ui?: EditorReloadUi): void => {
      if (!activeFileId) {
        return
      }
      void runEditorReloadFromDisk(activeFileId, () => fileContentsRef.current[activeFileId], {
        retryFailedLoad: (file) => reloadContentRef.current(file, USER_RETRY),
        announce: ui?.announce,
        focusScope: ui?.focusScope
      })
    },
    [activeFileId]
  )

  useEffect(() => {
    if (!isVisible || !activeFileId || !eligible) {
      return
    }
    const handler = (event: Event): void => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
      if (!isReloadRequestDetail(detail) || detail.fileId !== activeFileId) {
        return
      }
      detail.claim()
      reloadFromDisk()
    }
    window.addEventListener(ORCA_EDITOR_REQUEST_RELOAD_FROM_DISK_EVENT, handler)
    return () => window.removeEventListener(ORCA_EDITOR_REQUEST_RELOAD_FROM_DISK_EVENT, handler)
  }, [activeFileId, eligible, isVisible, reloadFromDisk])

  const paused = useEditorFileWatchPaused(eligible ? activeFile : null)
  // Why paused-only: a healthy watcher already reloads; this covers a revealed tab or a refocused
  // window while auto-reload is paused, at zero cost otherwise. Silent by design.
  useEffect(() => {
    if (!paused || !isVisible || !activeFileId) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let running = false
    // A silent read still running when this effect ends is dropped; the next reveal reads again.
    let active = true
    const check = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        const state = useAppStore.getState()
        const file = state.openFiles.find((tab) => tab.id === activeFileId)
        if (
          running ||
          isEditorReloadInFlight(activeFileId) ||
          !isLocalFileWatchPaused(localWatchedFilePath(state, file))
        ) {
          return
        }
        running = true
        // A click on any tab of this model during the silent read wins and this result is dropped.
        const explicit = watchExplicitReloads(
          normalizeRuntimePathForComparison(file?.filePath ?? '')
        )
        void reloadEditorFileFromDisk(activeFileId, fileContentsRef.current[activeFileId], {
          background: true,
          isSuperseded: () => !active || explicit.overtaken()
        }).finally(() => {
          explicit.stop()
          running = false
        })
      }, PAUSED_CHECK_DEBOUNCE_MS)
    }
    // Revealing the tab (or the pause starting while it is shown) counts as a reveal.
    check()
    window.addEventListener('focus', check)
    return () => {
      active = false
      window.removeEventListener('focus', check)
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [activeFileId, isVisible, paused])

  return { reloadFromDisk }
}
