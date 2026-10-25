import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatBytes } from '@/components/status-bar/workspace-space-format'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatToolResultBlock } from '../../../../shared/native-chat-types'
import {
  MAX_TOOL_DETAIL_LENGTH,
  truncateToolDetail
} from '../../../../shared/native-chat/tools/native-chat-tool-summary'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'

/** A partial detail response retains its original byte count. */
type FullOutput = { text: string; partial: { shown: number; total: number } | null }

function fullPayload(body: AgentJournalItemBody): AgentJournalBoundedPayload | null {
  if (body.kind === 'tool-call') {
    return body.output ?? null
  }
  return body.kind === 'diff' ? body.patch : null
}

/** Read full output from its owning host on request; keep expansion state independent of live revisions. */
export function NativeChatToolOutput({
  body
}: {
  body: NativeChatToolResultBlock
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<{
    body: NativeChatToolResultBlock
    owner: typeof owner
    full?: FullOutput
    loading?: boolean
    failed?: boolean
  } | null>(null)
  useEffect(
    () => () => setDetail((held) => (held?.body === body && held.owner === owner ? null : held)),
    [body, owner]
  )
  const current = detail?.body === body && detail.owner === owner ? detail : null
  const full = current?.full
  const loading = current?.loading === true
  const failed = current?.failed === true
  const clipped =
    !full &&
    (body.fullOutputItemId !== undefined ||
      (!expanded && body.output.length > MAX_TOOL_DETAIL_LENGTH))

  const showFull = async (): Promise<void> => {
    const itemId = body.fullOutputItemId
    if (itemId === undefined || owner === null) {
      setExpanded(true)
      return
    }
    setDetail({ body, owner, loading: true })
    const finish = (result: { full?: FullOutput; failed?: boolean }): void => {
      setDetail((held) =>
        held?.body === body && held.owner === owner ? { body, owner, ...result } : held
      )
    }
    try {
      if (!(await supportsStructuredAgentSessionItemDetail(owner.target))) {
        setExpanded(true)
        finish({})
        return
      }
      const item = await readStructuredAgentSessionItem(owner.target, owner.sessionId, itemId)
      const payload = item?.itemId === itemId ? fullPayload(item.body) : null
      if (!payload) {
        throw new Error('Output is unavailable')
      }
      finish({
        full: {
          text: payload.head,
          partial: payload.truncated
            ? {
                shown: new TextEncoder().encode(payload.head).length,
                total: payload.byteLength
              }
            : null
        }
      })
    } catch {
      finish({ failed: true })
    }
  }

  return (
    <div className="space-y-1">
      <pre
        data-native-chat-code-content
        className={cn(
          'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code scrollbar-sleek',
          body.isError ? 'text-destructive' : 'text-chat-foreground'
        )}
      >
        {full ? full.text : expanded ? body.output : truncateToolDetail(body.output)}
      </pre>
      {full?.partial ? (
        <p className="text-xs text-chat-foreground-faint">
          {translate(
            'components.native-chat.tool.fullOutputPartial',
            'Showing {{shown}} of {{total}}.',
            { shown: formatBytes(full.partial.shown), total: formatBytes(full.partial.total) }
          )}
        </p>
      ) : null}
      {clipped ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => void showFull()}
          >
            {translate('components.native-chat.tool.showFullOutput', 'Show full output')}
          </Button>
          {failed ? (
            <span className="text-xs text-chat-foreground-faint">
              {translate(
                'components.native-chat.tool.fullOutputFailed',
                "Couldn't load the full output."
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
