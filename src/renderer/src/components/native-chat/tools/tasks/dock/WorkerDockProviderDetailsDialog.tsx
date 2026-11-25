import { returnWorkerDockFocus, workerDockOpenerPane } from './worker-dock-focus-return'
import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { NativeChatBackgroundTaskRun } from '../NativeChatBackgroundTaskRun'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionHistoryResult } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { NativeChatBackgroundTaskBlock } from '../../../../../../../shared/native-chat/native-chat-types'
import type { WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockCommandBlock } from './WorkerDockCommandBlock'
import { useWorkerDockCommandDetail } from './use-worker-dock-command-detail'

export function WorkerDockProviderDetailsDialog({
  row,
  opener,
  sessionId,
  target,
  onClose
}: {
  row: WorkerDockRowView
  opener: HTMLElement
  sessionId: string
  target: RuntimeClientTarget
  onClose: () => void
}) {
  const [pane] = useState(() => workerDockOpenerPane(opener))
  // The held row as opened: output lookup and exact text never retarget while the dialog is up.
  const [held] = useState(row)
  const t = useTranslate()
  const [block, setBlock] = useState<NativeChatBackgroundTaskBlock | null>(null)
  const command = useWorkerDockCommandDetail(held, sessionId, target)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (held.settlement) {
        return
      }
      let cursor: AgentJournalCursor | undefined
      for (let page = 0; page < 20; page++) {
        const result = await callRuntimeRpc<AgentSessionHistoryResult>(
          target,
          'agentSession.history',
          {
            sessionId,
            direction: cursor ? 'before' : 'tail',
            ...(cursor ? { cursor } : {}),
            limit: 50
          }
        )
        if (cancelled || !result.ok) {
          return
        }
        for (const item of result.page.items.toReversed()) {
          if (item.body.kind !== 'message') {
            continue
          }
          const found = item.body.blocks.find(
            (candidate): candidate is NativeChatBackgroundTaskBlock =>
              candidate.type === 'background-task' && candidate.taskId === held.providerId
          )
          if (found) {
            setBlock(found)
            return
          }
        }
        if (!result.page.hasOlder || !result.page.window.oldest) {
          return
        }
        cursor = result.page.window.oldest
      }
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [held, sessionId, target])
  const isCommand = held.kind === 'command'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        scrollable
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnWorkerDockFocus(opener, pane)
        }}
      >
        <DialogHeader>
          <DialogTitle>{row.name}</DialogTitle>
          {isCommand ? null : <DialogDescription>{row.title}</DialogDescription>}
        </DialogHeader>
        {isCommand ? (
          <WorkerDockCommandBlock
            text={command.exact ?? row.title}
            exact={command.exact !== null}
            onCopy={command.copy}
          />
        ) : null}
        {block ? (
          <NativeChatBackgroundTaskRun block={block} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {row.reason ??
              (row.kind === 'command'
                ? t(
                    'components.native-chat.workerDock.commandOutputPending',
                    'Command output is not available yet.'
                  )
                : t(
                    'components.native-chat.workerDock.resultUnavailable',
                    'Worker result unavailable'
                  ))}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
