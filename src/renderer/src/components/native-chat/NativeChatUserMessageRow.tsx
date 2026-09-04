import { useState, type Ref } from 'react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isAgentSessionContinuationPrompt } from '@/lib/agent-session-continuation'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'

export function NativeChatUserMessageRow({
  rowRef,
  markdown,
  prose,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryFailed = false,
  runtimeContext
}: {
  rowRef: Ref<HTMLDivElement>
  markdown: string
  prose: NativeChatBlock[]
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryFailed?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  return (
    <div ref={rowRef} className="flex flex-col items-end gap-0.5">
      {isAgentSessionContinuationPrompt(markdown) ? (
        <ContinuationPromptCard
          markdown={markdown}
          prose={prose}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          runtimeContext={runtimeContext}
        />
      ) : (
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          <UserPromptBody
            markdown={markdown}
            prose={prose}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            runtimeContext={runtimeContext}
          />
        </div>
      )}
      {deliveryFailed ? (
        <div className="max-w-[85%] text-[11px] text-destructive/80">
          {translate(
            'components.native-chat.launchPromptNotDelivered',
            'Not delivered — check the terminal'
          )}
        </div>
      ) : null}
    </div>
  )
}

function ContinuationPromptCard({
  markdown,
  prose,
  onLinkClick,
  allowFileUriLinks,
  runtimeContext
}: {
  markdown: string
  prose: NativeChatBlock[]
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = translate(
    'components.native-chat.continuationPrompt.summary',
    'Continue from prior session'
  )
  return (
    <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className={cn('transition-transform', open && 'rotate-90')}>
          ›
        </span>
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      {open ? (
        <div className="px-3.5 pb-2.5 text-sm text-foreground">
          <UserPromptBody
            markdown={markdown}
            prose={prose}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            runtimeContext={runtimeContext}
          />
        </div>
      ) : null}
    </div>
  )
}

function UserPromptBody({
  markdown,
  prose,
  onLinkClick,
  allowFileUriLinks,
  runtimeContext
}: {
  markdown: string
  prose: NativeChatBlock[]
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  return (
    <>
      <NativeChatImageAttachments
        blocks={prose}
        runtimeContext={runtimeContext}
        enablePreview={runtimeContext !== undefined}
      />
      {markdown ? (
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      ) : null}
    </>
  )
}
