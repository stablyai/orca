import type { ReactNode } from 'react'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { OpenFile } from '@/store/slices/editor'
import type { TerminalTab, Worktree } from '../../../../shared/types'

type TerminalShellProps = {
  activeWorktreeId: string | null
  activeView: string
  tabs: TerminalTab[]
  activeTabId: string | null
  activeFileId: string | null
  activeTabType: 'terminal' | 'editor'
  expandedPaneByTabId: Record<string, boolean>
  worktreeFiles: OpenFile[]
  mountedWorktrees: Worktree[]
  tabsByWorktree: Record<string, TerminalTab[]>
  onActivateTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseTabsToRight: (tabId: string) => void
  onReorderTabs: (worktreeId: string, tabIds: string[]) => void
  onNewTerminalTab: () => void
  onNewBrowserTab: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  onActivateFile: (fileId: string) => void
  onCloseFile: (fileId: string) => void
  onCloseAllFiles: () => void
  onPinFile: (fileId: string) => void
  onPtyExit: (tabId: string, ptyId: string) => void
  tabBarOrder?: string[]
  editorPanel: ReactNode
  saveDialogFileId: string | null
  saveDialogFile: OpenFile | null
  onSaveDialogOpenChange: (open: boolean) => void
  onSaveDialogCancel: () => void
  onSaveDialogDiscard: () => void
  onSaveDialogSave: () => void
}

export function TerminalShell({
  activeWorktreeId,
  activeView,
  tabs,
  activeTabId,
  activeFileId,
  activeTabType,
  expandedPaneByTabId,
  worktreeFiles,
  mountedWorktrees,
  tabsByWorktree,
  onActivateTab,
  onCloseTab,
  onCloseOthers,
  onCloseTabsToRight,
  onReorderTabs,
  onNewTerminalTab,
  onNewBrowserTab,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePaneExpand,
  onActivateFile,
  onCloseFile,
  onCloseAllFiles,
  onPinFile,
  onPtyExit,
  tabBarOrder,
  editorPanel,
  saveDialogFileId,
  saveDialogFile,
  onSaveDialogOpenChange,
  onSaveDialogCancel,
  onSaveDialogDiscard,
  onSaveDialogSave
}: TerminalShellProps): React.JSX.Element {
  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${activeWorktreeId ? '' : ' hidden'}`}
    >
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: activeWorktreeId ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          {activeWorktreeId && (
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              worktreeId={activeWorktreeId}
              onActivate={onActivateTab}
              onClose={onCloseTab}
              onCloseOthers={onCloseOthers}
              onCloseToRight={onCloseTabsToRight}
              onReorder={onReorderTabs}
              onNewTerminalTab={onNewTerminalTab}
              onNewBrowserTab={onNewBrowserTab}
              onSetCustomTitle={onSetCustomTitle}
              onSetTabColor={onSetTabColor}
              expandedPaneByTabId={expandedPaneByTabId}
              onTogglePaneExpand={onTogglePaneExpand}
              editorFiles={worktreeFiles}
              activeFileId={activeFileId}
              activeTabType={activeTabType}
              onActivateFile={onActivateFile}
              onCloseFile={onCloseFile}
              onCloseAllFiles={onCloseAllFiles}
              onPinFile={onPinFile}
              tabBarOrder={tabBarOrder}
            />
          )}
        </div>
      </div>

      <div
        className={`relative flex-1 min-h-0 overflow-hidden ${activeTabType === 'editor' && worktreeFiles.length > 0 ? 'hidden' : ''}`}
      >
        {mountedWorktrees.map((worktree) => {
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
                  isActive={isVisible && tab.id === activeTabId}
                  onPtyExit={(ptyId) => onPtyExit(tab.id, ptyId)}
                  onCloseTab={() => onCloseTab(tab.id)}
                />
              ))}
            </div>
          )
        })}
      </div>

      {activeWorktreeId && activeTabType === 'editor' && worktreeFiles.length > 0 && editorPanel}

      <Dialog open={saveDialogFileId !== null} onOpenChange={onSaveDialogOpenChange}>
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
            <Button type="button" variant="outline" size="sm" onClick={onSaveDialogCancel}>
              Cancel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onSaveDialogDiscard}>
              Don&apos;t Save
            </Button>
            <Button type="button" size="sm" onClick={onSaveDialogSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
