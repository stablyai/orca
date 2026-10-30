import { useId, useLayoutEffect, useRef, useState } from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageOverflows,
  agentMessageFoldLabel,
  agentMessageCanCopy,
  AGENT_MESSAGE_FOLDED_LINES
} from '../../../../shared/agent-session/agent-message-presentation'
import { agentMessageTranscriptText } from '../../../../shared/agent-session/agent-message-display-text'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'

function heading(from: AgentMessageSource): string {
  switch (agentMessageHeading(from)) {
    case 'task':
      return translate(
        'components.native-chat.agentMessage.taskFromCoordinator',
        'Task from your coordinator'
      )
    case 'coordinator':
      return translate(
        'components.native-chat.agentMessage.messageFromCoordinator',
        'Message from your coordinator'
      )
    case 'worker':
      return translate(
        'components.native-chat.agentMessage.updateFromWorker',
        'Update from your worker'
      )
    case 'generic':
      return translate('components.native-chat.agentMessage.messageFrom', 'Message from')
  }
}

export function NativeChatAgentMessageCard({
  message,
  from,
  runtimeContext,
  onLinkClick,
  allowFileUriLinks,
  onRefolded
}: {
  message: NativeChatMessage
  from: AgentMessageSource
  runtimeContext?: RuntimeFileOperationArgs | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks: boolean
  onRefolded: () => void
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? runtimeContext?.worktreeId ?? null
  const target = owner?.target ?? runtimeContext?.target
  const text = agentMessageTranscriptText(message.blocks, from)
  const disclosure = useNativeChatDisclosure(`agent-message:${message.id}`, false)
  const clip = useRef<HTMLDivElement>(null)
  const clipId = useId()
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = clip.current
    if (!element) {
      return
    }
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setOverflows(agentMessageOverflows(element.scrollHeight, lineHeight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return (
    <div className="group flex w-full gap-3 rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
      <AgentMessageAvatar
        sender={agentMessagePrimarySender(from)}
        worktreeId={worktreeId}
        target={target}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{heading(from)}</span>
          <NativeChatMessageTimestamp
            timestamp={message.timestamp}
            className="text-muted-foreground"
          />
        </div>
        <NativeChatAgentMessageSenders from={from} chatWorktreeId={worktreeId} target={target} />
        <NativeChatImageAttachments
          blocks={message.blocks}
          runtimeContext={runtimeContext}
          enablePreview={runtimeContext !== undefined}
        />
        <div
          ref={clip}
          id={clipId}
          className={cn(
            'overflow-hidden leading-6',
            overflows && !disclosure.open && 'mask-b-from-[calc(100%-1.75rem)]'
          )}
          style={disclosure.open ? undefined : { maxHeight: `${AGENT_MESSAGE_FOLDED_LINES}lh` }}
          onBlur={(event) => {
            if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
              event.currentTarget.scrollTop = 0
            }
          }}
        >
          <NativeChatMarkdown
            rowKey={message.id}
            content={text}
            variant="document"
            className="text-sm"
            renderCodeBlock={NativeChatCodeBlock}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </div>
        <div className="flex items-center justify-between">
          {overflows ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={disclosure.open}
              aria-controls={clipId}
              onClick={() => {
                disclosure.setOpen(!disclosure.open)
                if (disclosure.open) {
                  requestAnimationFrame(onRefolded)
                }
              }}
            >
              {agentMessageFoldLabel(disclosure.open) === 'expanded'
                ? translate('components.native-chat.userMessage.showLess', 'Show less')
                : translate('components.native-chat.agentMessage.showMore', 'Show more')}
            </Button>
          ) : (
            <span />
          )}
          {agentMessageCanCopy(text) ? (
            <NativeChatCopyButton
              text={text}
              className="transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100"
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AgentMessageAvatar({
  sender,
  worktreeId,
  target
}: {
  sender: AgentMessageSource['senders'][number] | undefined
  worktreeId: string | null
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const view = useAgentMessageSenderView(sender, worktreeId, target)
  return (
    <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
      <AgentTypeIcon agentType={view.agentType} size={16} />
      {view.dot ? (
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-card ring-2 ring-card">
          <AgentStateDot state={view.dot} size="md" progress={view.progress} />
        </span>
      ) : null}
    </div>
  )
}
