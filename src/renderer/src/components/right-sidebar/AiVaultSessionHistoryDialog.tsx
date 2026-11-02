import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_AGENTS, aiVaultHistoryAgents } from '../../../../shared/ai-vault-types'
import AiVaultPanel from './AiVaultPanel'
import type { AiVaultPanelHandle } from './ai-vault-panel-handle'
import { readAgentSessionHistoryModalRequest } from './agent-session-history-modal'

function selectVisibleTabs(state: AppState, chatWorkspaceId: string | null): string {
  const focusedTab = (workspaceId: string | null): string => {
    const groupId = workspaceId ? state.activeGroupIdByWorktree[workspaceId] : undefined
    const groups = workspaceId ? state.groupsByWorktree[workspaceId] : undefined
    return groups?.find((group) => group.id === groupId)?.activeTabId ?? ''
  }
  return [state.activeWorktreeId, focusedTab(state.activeWorktreeId), focusedTab(chatWorkspaceId)]
    .map((part) => part ?? '')
    .join('\n')
}

/** `/resume`'s Session History: each opening mounts a fresh panel, apart from the sidebar's. */
export default function AiVaultSessionHistoryDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const confirm = useConfirmationDialog()
  const request = readAgentSessionHistoryModalRequest(modalData)
  const chatWorkspaceId = request?.workspace.worktreeId ?? null
  const panelRef = useRef<AiVaultPanelHandle>(null)
  // Why: the slot has no trigger element for the dialog to hand focus back to.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  // Tab changes prove an action opened a destination; failed actions leave this dialog in place.
  const visibleTabs = useAppStore((s) => selectVisibleTabs(s, chatWorkspaceId))
  const [openedOver] = useState(visibleTabs)
  const tabsChanged = visibleTabs !== openedOver
  useEffect(() => {
    if (tabsChanged) {
      closeModal()
    }
  }, [closeModal, tabsChanged])
  if (!request) {
    return null
  }
  const enterKey = navigator.userAgent.includes('Mac') ? '⏎' : 'Enter'
  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        surface="panel"
        className="flex h-[min(640px,calc(100vh-4rem))] flex-col overflow-hidden sm:max-w-[560px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panelRef.current?.focusSearch()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // The chat keeps focus unless the user was taken to another tab.
          const stayed = selectVisibleTabs(useAppStore.getState(), chatWorkspaceId) === openedOver
          if (stayed && returnFocusTo?.isConnected) {
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
        onEscapeKeyDown={(event) => {
          // Overlay dismissal runs before the search box sees Escape, so clear the search here.
          if (panelRef.current?.clearSearch()) {
            event.preventDefault()
          }
        }}
      >
        <DialogTitle className="sr-only">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.sessionHistory',
            'Agent Session History'
          )}
        </DialogTitle>
        <div className="min-h-0 flex-1">
          <AiVaultPanel
            ref={panelRef}
            workspace={request.workspace}
            initialQuery={request.initialQuery}
            // An agent the filter doesn't list leaves every agent shown rather than none.
            initialAgents={request.agent ? aiVaultHistoryAgents(request.agent) : AI_VAULT_AGENTS}
            onSessionOpened={closeModal}
            resumeHere={{
              tabId: request.chatTabId,
              workspaceId: request.workspace.worktreeId,
              agent: request.agent,
              // A refusal can settle after this opening closed and another modal took the slot.
              dismiss: () => {
                if (useAppStore.getState().modalData === modalData) {
                  closeModal()
                }
              },
              confirm
            }}
            headerAction={
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-6"
                  aria-label={translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
                >
                  <X className="size-3" />
                </Button>
              </DialogClose>
            }
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-sidebar-border bg-sidebar px-3 py-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ShortcutKeyCombo keys={['↑']} />
            <ShortcutKeyCombo keys={['↓']} />
            {translate('sessionHistory.dialog.select', 'Select')}
          </span>
          <span className="inline-flex items-center gap-1">
            <ShortcutKeyCombo keys={[enterKey]} />
            {translate('sessionHistory.dialog.open', 'Open')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
