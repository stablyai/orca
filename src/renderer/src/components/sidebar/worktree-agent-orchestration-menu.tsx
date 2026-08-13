import { useCallback, useEffect, useState } from 'react'
import { Copy, MessagesSquare, Send, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  buildOrchestrationAskCommand,
  buildOrchestrationSendCommand,
  buildWorktreeGroupAddress,
  resolveTerminalHandleForPaneKey
} from '@/components/dashboard/agent-row-orchestration-clipboard'
import {
  findActiveDispatchForWorker,
  type OrchestrationActionKind
} from './agent-row-orchestration-actions'

/** Marker so the worktree context menu can offer agent orchestration actions. */
export const AGENT_ROW_ORCHESTRATION_ATTR = 'data-agent-row-orchestration'

export type AgentRowOrchestrationTarget = {
  paneKey: string
  worktreeId: string | null
  coordinatorHandle: string | null
  dispatchId: string | null
  taskId: string | null
  dispatchStatus: string | null
}

function orchestrationTargetFromElement(row: Element): AgentRowOrchestrationTarget | null {
  const paneKey = row.getAttribute('data-pane-key')?.trim()
  if (!paneKey) {
    return null
  }
  const worktreeId = row.getAttribute('data-worktree-id')?.trim() || null
  const coordinatorHandle = row.getAttribute('data-coordinator-handle')?.trim() || null
  const dispatchId = row.getAttribute('data-dispatch-id')?.trim() || null
  const taskId = row.getAttribute('data-task-id')?.trim() || null
  const dispatchStatus = row.getAttribute('data-dispatch-status')?.trim() || null
  return { paneKey, worktreeId, coordinatorHandle, dispatchId, taskId, dispatchStatus }
}

export function readAgentRowOrchestrationTarget(
  target: EventTarget | null,
  event?: Event | null
): AgentRowOrchestrationTarget | null {
  // Why: React synthetic events and text-node targets can miss closest(); walk
  // the composed path first so agent-row right-clicks always resolve.
  if (event && typeof event.composedPath === 'function') {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.hasAttribute(AGENT_ROW_ORCHESTRATION_ATTR)) {
        return orchestrationTargetFromElement(node)
      }
    }
  }
  const element = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null }
  } | null
  const row =
    element?.closest?.(`[${AGENT_ROW_ORCHESTRATION_ATTR}]`) ??
    element?.parentElement?.closest?.(`[${AGENT_ROW_ORCHESTRATION_ATTR}]`)
  if (!row) {
    return null
  }
  return orchestrationTargetFromElement(row)
}

export function agentRowOrchestrationDataProps(target: {
  paneKey: string
  worktreeId?: string | null
  coordinatorHandle?: string | null
  dispatchId?: string | null
  taskId?: string | null
  dispatchStatus?: string | null
}): Record<string, string> {
  const props: Record<string, string> = {
    [AGENT_ROW_ORCHESTRATION_ATTR]: '',
    'data-pane-key': target.paneKey
  }
  if (target.worktreeId) {
    props['data-worktree-id'] = target.worktreeId
  }
  if (target.coordinatorHandle) {
    props['data-coordinator-handle'] = target.coordinatorHandle
  }
  if (target.dispatchId) {
    props['data-dispatch-id'] = target.dispatchId
  }
  if (target.taskId) {
    props['data-task-id'] = target.taskId
  }
  if (target.dispatchStatus) {
    props['data-dispatch-status'] = target.dispatchStatus
  }
  return props
}

export function activeDispatchFromTarget(
  target: AgentRowOrchestrationTarget
): { taskId: string; dispatchId: string } | null {
  if (
    (target.dispatchStatus !== 'pending' && target.dispatchStatus !== 'dispatched') ||
    !target.dispatchId ||
    !target.taskId
  ) {
    return null
  }
  return { taskId: target.taskId, dispatchId: target.dispatchId }
}

type Props = {
  target: AgentRowOrchestrationTarget
  onRequestAction: (kind: OrchestrationActionKind) => void
}

// Why: live on the worktree context menu (not a nested Radix ContextMenu) so
// right-click on an agent row cannot be swallowed by WorktreeContextMenu's
// capture handler — the same menu users already open on the card.
export function WorktreeAgentOrchestrationMenuSection({ target, onRequestAction }: Props) {
  const worktreeAddress = target.worktreeId ? buildWorktreeGroupAddress(target.worktreeId) : null
  const coordinator = target.coordinatorHandle
  // Why: skill/runtime allow only one active dispatch per assignee — disable
  // Dispatch in the menu so users do not hit a late RPC error.
  const [workerBusy, setWorkerBusy] = useState(false)
  const [workerBusyLabel, setWorkerBusyLabel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const known = activeDispatchFromTarget(target)
    if (known) {
      setWorkerBusy(true)
      setWorkerBusyLabel(
        translate(
          'auto.components.dashboard.AgentRowContextMenu.dispatch.busy',
          'Already has active dispatch {{dispatchId}} (task {{taskId}})',
          { dispatchId: known.dispatchId, taskId: known.taskId }
        )
      )
      return () => {
        cancelled = true
      }
    }
    setWorkerBusy(false)
    setWorkerBusyLabel(null)
    void findActiveDispatchForWorker({
      workerPaneKey: target.paneKey,
      callRuntime: window.api.runtime.call as (request: {
        method: string
        params?: Record<string, unknown>
      }) => ReturnType<typeof window.api.runtime.call>
    })
      .then((active) => {
        if (cancelled || !active) {
          return
        }
        setWorkerBusy(true)
        setWorkerBusyLabel(
          translate(
            'auto.components.dashboard.AgentRowContextMenu.dispatch.busy',
            'Already has active dispatch {{dispatchId}} (task {{taskId}})',
            { dispatchId: active.dispatchId, taskId: active.taskId }
          )
        )
      })
      .catch(() => {
        // Best-effort: leave Dispatch enabled; submit path re-checks.
      })
    return () => {
      cancelled = true
    }
  }, [target])

  const copyText = useCallback(async (text: string, successLabel: string) => {
    try {
      await window.api.ui.writeClipboardText(text)
      toast.success(successLabel)
    } catch {
      toast.error(
        translate('auto.components.dashboard.AgentRowContextMenu.copy.failed', 'Unable to copy')
      )
    }
  }, [])

  const copyResolvedHandle = useCallback(
    async (build: (handle: string) => string, successLabel: string) => {
      try {
        const handle = await resolveTerminalHandleForPaneKey({
          paneKey: target.paneKey,
          callRuntime: window.api.runtime.call
        })
        await window.api.ui.writeClipboardText(build(handle))
        toast.success(successLabel)
      } catch {
        toast.error(
          translate(
            'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copy.failed',
            'Unable to copy terminal ID'
          )
        )
      }
    },
    [target.paneKey]
  )

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Workflow className="size-3.5" />
          {translate(
            'auto.components.dashboard.AgentRowContextMenu.orchestration',
            'Orchestration'
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-56">
          <DropdownMenuItem
            disabled={workerBusy}
            title={workerBusyLabel ?? undefined}
            onSelect={() => {
              if (workerBusy) {
                return
              }
              onRequestAction('dispatch')
            }}
          >
            <Send className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.dispatchToAgent',
              'Dispatch to this agent…'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onRequestAction('send')
            }}
          >
            <MessagesSquare className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.sendToAgent',
              'Send message to this agent…'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onRequestAction('ask')
            }}
          >
            <MessagesSquare className="size-3.5" />
            {translate('auto.components.dashboard.AgentRowContextMenu.askAgent', 'Ask this agent…')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void copyResolvedHandle(
                (handle) => handle,
                translate(
                  'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copied',
                  'Terminal ID copied'
                )
              )
            }}
          >
            <Copy className="size-3.5" />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.copyTerminalId',
              'Copy Terminal ID'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void copyResolvedHandle(
                buildOrchestrationSendCommand,
                translate(
                  'auto.components.dashboard.AgentRowContextMenu.send.command.copied',
                  'Send command copied'
                )
              )
            }}
          >
            <Copy className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.copySendCommand',
              'Copy send command'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void copyResolvedHandle(
                buildOrchestrationAskCommand,
                translate(
                  'auto.components.dashboard.AgentRowContextMenu.ask.command.copied',
                  'Ask command copied'
                )
              )
            }}
          >
            <Copy className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.copyAskCommand',
              'Copy ask command'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!worktreeAddress}
            onSelect={() => {
              if (!worktreeAddress) {
                return
              }
              void copyText(
                worktreeAddress,
                translate(
                  'auto.components.dashboard.AgentRowContextMenu.worktree.address.copied',
                  'Worktree address copied'
                )
              )
            }}
          >
            <Copy className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.copyWorktreeAddress',
              'Copy worktree address'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!coordinator}
            onSelect={() => {
              if (!coordinator) {
                return
              }
              void copyText(
                coordinator,
                translate(
                  'auto.components.dashboard.AgentRowContextMenu.coordinator.handle.copied',
                  'Coordinator handle copied'
                )
              )
            }}
          >
            <Copy className="size-3.5" />
            {translate(
              'auto.components.dashboard.AgentRowContextMenu.copyCoordinatorHandle',
              'Copy coordinator handle'
            )}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  )
}
