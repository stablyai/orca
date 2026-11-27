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
  const t = useTranslate()
  const [block, setBlock] = useState<NativeChatBackgroundTaskBlock | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (row.settlement) {
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
          const command = item.body.blocks.find(
            (candidate): candidate is NativeChatBackgroundTaskBlock =>
              candidate.type === 'background-task' && candidate.taskId === row.providerId
          )
          if (command) {
            setBlock(command)
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
  }, [row, sessionId, target])
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
          <DialogDescription>{row.title}</DialogDescription>
        </DialogHeader>
        {block ? (
          <NativeChatBackgroundTaskRun block={block} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {row.reason ??
              (row.kind !== 'agent' && row.kind !== 'worker'
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
