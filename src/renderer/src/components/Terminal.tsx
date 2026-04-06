/* eslint-disable max-lines */

import { useEffect, useCallback, useRef, useState, lazy, Suspense } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { useAppStore } from '../store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import TabBar from './tab-bar/TabBar'
import TerminalPane from './terminal-pane/TerminalPane'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorSaveQuiesce
} from './editor/editor-autosave'
import { isUpdaterQuitAndInstallInProgress } from '@/lib/updater-beforeunload'
import EditorAutosaveController from './editor/EditorAutosaveController'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

export default function Terminal(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeView = useAppStore((s) => s.activeView)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const setActiveTabType = useAppStore((s) => s.setActiveTabType)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const closeFile = useAppStore((s) => s.closeFile)
  const closeAllFiles = useAppStore((s) => s.closeAllFiles)
  const pinFile = useAppStore((s) => s.pinFile)

  const markFileDirty = useAppStore((s) => s.markFileDirty)

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const allWorktrees = Object.values(worktreesByRepo).flat()

  // Filter editor files to only show those belonging to the active worktree
  const worktreeFiles = activeWorktreeId
    ? openFiles.filter((f) => f.worktreeId === activeWorktreeId)
    : []

  // Save confirmation dialog state
  const [saveDialogFileId, setSaveDialogFileId] = useState<string | null>(null)
  const saveDialogFile = saveDialogFileId ? openFiles.find((f) => f.id === saveDialogFileId) : null

  // Window close confirmation dialog — shown when the user tries to close the
  // window (X button, Cmd+Q) while terminals with running processes exist.
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)

  const handleCloseFile = useCallback(
    (fileId: string) => {
      const file = useAppStore.getState().openFiles.find((f) => f.id === fileId)
      if (file?.isDirty) {
        setSaveDialogFileId(fileId)
        return
      }
      closeFile(fileId)
    },
    [closeFile]
  )

  const handleSaveDialogSave = useCallback(async () => {
    if (!saveDialogFileId) {
      return
    }
    const file = useAppStore.getState().openFiles.find((f) => f.id === saveDialogFileId)
    if (!file) {
      return
    }
    // Why: save-and-close must flush the latest draft even when the visible
    // editor panel has already unmounted. The headless autosave controller
    // owns that write path now, so the dialog signals it through a custom
    // event instead of poking at editor component refs.
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: saveDialogFileId } })
    )
    setSaveDialogFileId(null)
  }, [saveDialogFileId])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (!saveDialogFileId) {
      return
    }
    // Why: autosave runs on a background timer. Wait for any pending/in-flight
    // write to settle before honoring "Don't Save", otherwise the file can be
    // written after the user explicitly chose to discard their edits.
    await requestEditorSaveQuiesce({ fileId: saveDialogFileId })
    markFileDirty(saveDialogFileId, false)
    closeFile(saveDialogFileId)
    setSaveDialogFileId(null)
  }, [saveDialogFileId, closeFile, markFileDirty])

  const handleSaveDialogCancel = useCallback(() => {
    setSaveDialogFileId(null)
  }, [])

  // Ensure activeTabId is valid (adjusting state during render)
  if (tabs.length > 0 && (!activeTabId || !tabs.find((t) => t.id === activeTabId))) {
    setActiveTab(tabs[0].id)
  }

  // Track which worktrees have been activated during this app session.
  // Only mount TerminalPanes for visited worktrees to prevent mass PTY
  // spawning when restoring a session with many saved worktree tabs.
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  // Why: gated on workspaceSessionReady to prevent TerminalPane from mounting
  // before reconnectPersistedTerminals() has finished eagerly spawning PTYs.
  // Without this gate, Phase 1 (hydrateWorkspaceSession) sets activeWorktreeId
  // with ptyId: null, and TerminalPane would call connectPanePty → pty:spawn,
  // creating a duplicate PTY for the same tab.
  if (activeWorktreeId && workspaceSessionReady) {
    mountedWorktreeIdsRef.current.add(activeWorktreeId)
  }
  // Prune IDs of worktrees that no longer exist (deleted/removed)
  const allWorktreeIds = new Set(allWorktrees.map((wt) => wt.id))
  for (const id of mountedWorktreeIdsRef.current) {
    if (!allWorktreeIds.has(id)) {
      mountedWorktreeIdsRef.current.delete(id)
    }
  }
  const initialTabCreationGuardRef = useRef<string | null>(null)

  // Auto-create first tab when worktree activates
  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    if (!activeWorktreeId) {
      initialTabCreationGuardRef.current = null
      return
    }

    if (tabs.length > 0) {
      if (initialTabCreationGuardRef.current === activeWorktreeId) {
        initialTabCreationGuardRef.current = null
      }
      return
    }

    // In React StrictMode (dev), mount effects are intentionally invoked twice.
    // Track the worktree we already initialized so we only create one first tab.
    if (initialTabCreationGuardRef.current === activeWorktreeId) {
      return
    }
    initialTabCreationGuardRef.current = activeWorktreeId
    createTab(activeWorktreeId)
  }, [workspaceSessionReady, activeWorktreeId, tabs.length, createTab])

  const totalTabs = tabs.length + worktreeFiles.length

  const handleNewTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    createTab(activeWorktreeId)
  }, [activeWorktreeId, createTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const state = useAppStore.getState()
      const owningWorktreeEntry = Object.entries(state.tabsByWorktree).find(([, worktreeTabs]) =>
        worktreeTabs.some((tab) => tab.id === tabId)
      )
      const owningWorktreeId = owningWorktreeEntry?.[0] ?? null

      if (!owningWorktreeId) {
        return
      }

      const currentTabs = state.tabsByWorktree[owningWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        // Last tab in this worktree. Only clear the active worktree if this
        // tab belongs to the currently focused worktree.
        closeTab(tabId)
        if (state.activeWorktreeId === owningWorktreeId) {
          setActiveWorktree(null)
        }
        return
      }

      // If closing the active tab in the active worktree, switch to a neighbor.
      if (state.activeWorktreeId === owningWorktreeId && tabId === state.activeTabId) {
        const idx = currentTabs.findIndex((t) => t.id === tabId)
        const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1]
        if (nextTab) {
          setActiveTab(nextTab.id)
        }
      }
      closeTab(tabId)
    },
    [closeTab, setActiveTab, setActiveWorktree]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      handleCloseTab(tabId)
    },
    [consumeSuppressedPtyExit, handleCloseTab]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      setActiveTab(tabId)
      for (const tab of currentTabs) {
        if (tab.id !== tabId) {
          closeTab(tab.id)
        }
      }
    },
    [activeWorktreeId, closeTab, setActiveTab]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      const index = currentTabs.findIndex((t) => t.id === tabId)
      if (index === -1) {
        return
      }
      const rightTabs = currentTabs.slice(index + 1)
      for (const tab of rightTabs) {
        closeTab(tab.id)
      }
    },
    [activeWorktreeId, closeTab]
  )

  const handleActivateTab = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      setActiveTabType('terminal')
    },
    [setActiveTab, setActiveTabType]
  )

  const handleTogglePaneExpand = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId }
          })
        )
      })
    },
    [setActiveTab]
  )

  // Keyboard shortcuts
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      // Cmd/Ctrl+T - new tab
      if (mod && e.key === 't' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        handleNewTab()
        return
      }

      // Cmd/Ctrl+W - close active editor tab or terminal pane.
      // Terminal pane/tab close is handled by the pane-level keyboard handler
      // in keyboard-handlers.ts so it can close individual split panes and
      // show a confirmation dialog. We still preventDefault here so Electron
      // doesn't close the window as its default Cmd+W action.
      if (mod && e.key === 'w' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        const state = useAppStore.getState()
        if (state.activeTabType === 'editor' && state.activeFileId) {
          handleCloseFile(state.activeFileId)
        }
        return
      }

      // Cmd/Ctrl+Shift+] and Cmd/Ctrl+Shift+[ - switch tabs
      if (mod && e.shiftKey && (e.key === ']' || e.key === '[') && !e.repeat) {
        const state = useAppStore.getState()
        const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
        const currentEditorFiles = activeWorktreeId
          ? state.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
          : []

        // Build unified tab list: terminal tabs then editor tabs
        const allTabIds: { type: 'terminal' | 'editor'; id: string }[] = [
          ...currentTerminalTabs.map((t) => ({ type: 'terminal' as const, id: t.id })),
          ...currentEditorFiles.map((f) => ({ type: 'editor' as const, id: f.id }))
        ]

        if (allTabIds.length > 1) {
          e.preventDefault()
          const currentId =
            state.activeTabType === 'editor' ? state.activeFileId : state.activeTabId
          const idx = allTabIds.findIndex((t) => t.id === currentId)
          const dir = e.key === ']' ? 1 : -1
          const next = allTabIds[(idx + dir + allTabIds.length) % allTabIds.length]
          if (next.type === 'terminal') {
            setActiveTab(next.id)
            state.setActiveTabType('terminal')
          } else {
            state.setActiveFile(next.id)
            state.setActiveTabType('editor')
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeWorktreeId, handleNewTab, handleCloseTab, handleCloseFile, setActiveTab])

  // Warn on window close if there are unsaved editor files
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      // Why: updater restarts intentionally close the app even if a hidden
      // editor tab still reports dirty. Let ShipIt replace the bundle instead
      // of vetoing quitAndInstall and leaving the old version running.
      if (isUpdaterQuitAndInstallInProgress()) {
        return
      }
      const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty)
      if (dirtyFiles.length > 0) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Listen for main-process window close requests. When any terminal has a
  // child process running (not just an idle shell), show a confirmation dialog.
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(() => {
      if (isUpdaterQuitAndInstallInProgress()) {
        window.api.ui.confirmWindowClose()
        return
      }
      const state = useAppStore.getState()
      const allPtyIds = Object.values(state.ptyIdsByTabId).flat()
      if (allPtyIds.length === 0) {
        window.api.ui.confirmWindowClose()
        return
      }
      void Promise.all(allPtyIds.map((id) => window.api.pty.hasChildProcesses(id))).then(
        (results) => {
          if (results.some(Boolean)) {
            setWindowCloseDialogOpen(true)
          } else {
            window.api.ui.confirmWindowClose()
          }
        }
      )
    })
  }, [])

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${activeWorktreeId ? '' : ' hidden'}`}
    >
      <EditorAutosaveController />

      {/* Animated tab bar container using CSS grid for smooth height animation */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: activeWorktreeId && totalTabs >= 2 ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          {activeWorktreeId && (
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              worktreeId={activeWorktreeId}
              onActivate={handleActivateTab}
              onClose={handleCloseTab}
              onCloseOthers={handleCloseOthers}
              onCloseToRight={handleCloseTabsToRight}
              onReorder={reorderTabs}
              onNewTab={handleNewTab}
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              expandedPaneByTabId={expandedPaneByTabId}
              onTogglePaneExpand={handleTogglePaneExpand}
              editorFiles={worktreeFiles}
              activeFileId={activeFileId}
              activeTabType={activeTabType}
              onActivateFile={(fileId) => {
                setActiveFile(fileId)
                setActiveTabType('editor')
              }}
              onCloseFile={handleCloseFile}
              onCloseAllFiles={closeAllFiles}
              onPinFile={pinFile}
            />
          )}
        </div>
      </div>

      {/* Terminal panes container - hidden when editor tab active */}
      <div
        className={`relative flex-1 min-h-0 overflow-hidden ${activeTabType === 'editor' && worktreeFiles.length > 0 ? 'hidden' : ''}`}
      >
        {allWorktrees
          .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
          .map((worktree) => {
            const worktreeTabs = tabsByWorktree[worktree.id] ?? []
            const isVisible = activeView !== 'settings' && worktree.id === activeWorktreeId

            return (
              <div
                key={worktree.id}
                className={isVisible ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                aria-hidden={!isVisible}
              >
                {worktreeTabs.map((tab) => (
                  <TerminalPane
                    key={`${tab.id}-${tab.generation ?? 0}`}
                    tabId={tab.id}
                    worktreeId={worktree.id}
                    cwd={worktree.path}
                    isActive={isVisible && tab.id === activeTabId && activeTabType === 'terminal'}
                    onPtyExit={(ptyId) => handlePtyExit(tab.id, ptyId)}
                    onCloseTab={() => handleCloseTab(tab.id)}
                  />
                ))}
              </div>
            )
          })}
      </div>

      {/* Why: v1.0.85 only mounted the visible editor surface, which kept
          hidden editor effects out of app shutdown. Autosave now lives in the
          narrow EditorAutosaveController above, so the full EditorPanel can go
          back to the safer "mount only while visible" lifecycle. */}
      {activeWorktreeId && activeTabType === 'editor' && worktreeFiles.length > 0 && (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Loading editor...
            </div>
          }
        >
          <EditorPanel />
        </Suspense>
      )}

      {/* Save confirmation dialog */}
      <Dialog
        open={saveDialogFileId !== null}
        onOpenChange={(open) => {
          if (!open) {
            handleSaveDialogCancel()
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? `"${saveDialogFile.relativePath.split('/').pop()}" has unsaved changes. Do you want to save before closing?`
                : 'This file has unsaved changes.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogCancel}>
              Cancel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogDiscard}>
              Don&apos;t Save
            </Button>
            <Button type="button" size="sm" onClick={handleSaveDialogSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Window close confirmation dialog — shown when the window is being
          closed and terminals are still running. */}
      <Dialog
        open={windowCloseDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setWindowCloseDialogOpen(false)
          }
        }}
      >
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Close Window?</DialogTitle>
            <DialogDescription className="text-xs">
              There are terminals with running processes. If you close the window, those processes
              will be killed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWindowCloseDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => {
                setWindowCloseDialogOpen(false)
                window.api.ui.confirmWindowClose()
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
