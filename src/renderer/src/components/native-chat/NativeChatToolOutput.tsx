import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type { AgentJournalBoundedPayload } from '../../../../shared/agent-session-journal-types'
import type { NativeChatToolResultBlock } from '../../../../shared/native-chat-types'
import { truncateToolDetail } from '../../../../shared/native-chat/tools/native-chat-tool-summary'
import {
  isNativeChatToolOutputClipped,
  NATIVE_CHAT_TOOL_OUTPUT_COPY,
  nativeChatToolFullPayload,
  nativeChatToolOutputPartialSizes
} from '../../../../shared/native-chat/tools/native-chat-tool-output'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'

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
    full?: AgentJournalBoundedPayload
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
  const clipped = isNativeChatToolOutputClipped(body, { expanded, fullLoaded: Boolean(full) })
  const partial = useMemo(() => (full ? nativeChatToolOutputPartialSizes(full) : null), [full])

  const showFull = async (): Promise<void> => {
    const itemId = body.fullOutputItemId
    if (itemId === undefined || owner === null) {
      setExpanded(true)
      return
    }
    setDetail({ body, owner, loading: true })
    const finish = (result: { full?: AgentJournalBoundedPayload; failed?: boolean }): void => {
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
      const payload = item?.itemId === itemId ? nativeChatToolFullPayload(item.body) : null
      if (!payload) {
        throw new Error('Output is unavailable')
      }
      finish({ full: payload })
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
        {full ? full.head : expanded ? body.output : truncateToolDetail(body.output)}
      </pre>
      {partial ? (
        <p className="text-xs text-chat-foreground-faint">
          {translate(
            'components.native-chat.tool.fullOutputPartial',
            NATIVE_CHAT_TOOL_OUTPUT_COPY.partial,
            partial
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
