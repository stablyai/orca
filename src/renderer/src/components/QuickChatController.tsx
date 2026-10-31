import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { startQuickChat, showQuickChatFailure } from '@/lib/start-quick-chat'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { requestNativeChatComposerFocus } from './native-chat/use-native-chat-composer-reveal-focus'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useNewTabAgentMenuRows } from './tab-bar/use-new-tab-agent-menu-rows'
import { ProjectedAgentMenuItems, useTabAgentMenuLaunch } from './tab-bar/QuickLaunchButton'
import { useAgentLaunchPickerInventory } from './agent/use-agent-launch-picker-inventory'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

import { QUICK_CHAT_EVENT } from './QuickChatButton'

function useQuickChatDestination(worktreeId: string, open: boolean) {
  const detection = useAgentDetectionTargetForWorktree(worktreeId)
  const model = useNewTabAgentMenuRows(worktreeId, open, detection)
  const groupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId]) ?? ''
  const launch = useTabAgentMenuLaunch({
    worktreeId,
    groupId,
    onFocusTerminal: focusTerminalTabSurface,
    onFocusChat: requestNativeChatComposerFocus
  })
  const runLaunch: typeof launch = (...args) => {
    try {
      if (
        activateAndRevealWorktree(worktreeId, {
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          providesInitialSurface: true
        }) === false
      ) {
        showQuickChatFailure()
        return
      }
      launch(...args)
    } catch {
      showQuickChatFailure()
    }
  }
  return { model, runLaunch }
}

function QuickChatRequest({
  worktreeId,
  finish
}: {
  worktreeId: string
  finish: (pickerWorktreeId?: string) => void
}) {
  const { model, runLaunch } = useQuickChatDestination(worktreeId, true)
  const finished = useRef(false)
  useEffect(() => {
    if (model.state !== 'settled' || finished.current) {
      return
    }
    finished.current = true
    const row = model.rows.find((row) => row.kind === 'chat' && row.agent === model.defaultTuiAgent)
    if (row) {
      runLaunch(row)
      finish()
    } else {
      finish(worktreeId)
    }
  }, [model, runLaunch, finish, worktreeId])
  return null
}

function QuickChatMenu({ worktreeId }: { worktreeId: string }) {
  const { model, runLaunch } = useQuickChatDestination(worktreeId, true)
  const entries = useAgentLaunchPickerInventory(worktreeId, model, true)
  return <ProjectedAgentMenuItems model={model} runLaunch={runLaunch} pickerEntries={entries} />
}

export function QuickChatController() {
  const [requests, setRequests] = useState<
    { id: number; worktreeId: string; anchor: DOMRect; control: HTMLElement }[]
  >([])
  const [menu, setMenu] = useState<{
    worktreeId: string
    anchor: DOMRect
    control: HTMLElement
  } | null>(null)
  const sequence = useRef(0)
  useEffect(() => {
    const start = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.detail instanceof HTMLElement)) {
        return
      }
      const control = event.detail
      const anchor = control.getBoundingClientRect()
      const id = ++sequence.current
      void startQuickChat().then((worktreeId) => {
        if (worktreeId) {
          setRequests((current) => [...current, { id, worktreeId, anchor, control }])
        }
      })
    }
    window.addEventListener(QUICK_CHAT_EVENT, start)
    return () => window.removeEventListener(QUICK_CHAT_EVENT, start)
  }, [])
  return (
    <>
      {requests.map(({ id, worktreeId, anchor, control }) => (
        <QuickChatRequest
          key={id}
          worktreeId={worktreeId}
          finish={(pickerWorktreeId) => {
            if (pickerWorktreeId) {
              setMenu({ worktreeId: pickerWorktreeId, anchor, control })
            } else {
              setMenu(null)
            }
            setRequests((current) => current.filter((request) => request.id !== id))
          }}
        />
      ))}
      <DropdownMenu
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMenu(null)
          }
        }}
      >
        {menu && (
          <>
            <DropdownMenuTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none fixed"
                style={{
                  top: menu.anchor.top,
                  left: menu.anchor.left,
                  width: menu.anchor.width,
                  height: menu.anchor.height
                }}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                if (menu.control.isConnected) {
                  menu.control.focus()
                }
              }}
            >
              <QuickChatMenu worktreeId={menu.worktreeId} />
            </DropdownMenuContent>
          </>
        )}
      </DropdownMenu>
    </>
  )
}
