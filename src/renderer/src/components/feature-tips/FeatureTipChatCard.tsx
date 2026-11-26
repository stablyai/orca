import type { CSSProperties, JSX, ReactNode } from 'react'
import { ArrowUp, ChevronDown, Hand, Plus, Square, X } from 'lucide-react'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/session/options/controls/native-chat-permission-mode-labels'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import { CHAT_DEMO_MODEL, type ChatDemoSend } from './chat-ui-here-feature-tip-demo'

// The smallest chat text size, so the real chat spacing fits the 22rem card the sibling visuals use.
const CHAT_SCALE: CSSProperties & { '--chat-font-size': string } = { '--chat-font-size': '12px' }

/** A miniature chat tab: the transcript is bottom-anchored above `footer` (the composer). */
export function FeatureTipChatCard({
  tabTitle,
  footer,
  className,
  children
}: {
  tabTitle: string
  footer: ReactNode
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-[22rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-chat-canvas text-left tracking-[0.01em] shadow-xs motion-reduce:**:transition-none',
        className
      )}
      aria-hidden="true"
    >
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-card">
        <span className="-mb-px flex max-w-[75%] items-center gap-1.5 border-r border-border bg-chat-canvas px-3 text-[11px] whitespace-nowrap text-foreground">
          <span className="shrink-0">
            <AgentIcon agent="claude" size={12} />
          </span>
          <span className="truncate">{tabTitle}</span>
          <X className="ml-1 size-2.5 shrink-0 text-muted-foreground" />
        </span>
      </div>
      <div
        className="native-chat-appearance flex min-h-0 flex-1 flex-col text-sm leading-relaxed text-chat-foreground"
        style={CHAT_SCALE}
      >
        {/* Bottom-anchored, so a transcript taller than the card keeps its end in view. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-[calc(var(--spacing)*3+5px)]">
          {children}
        </div>
        {footer}
      </div>
    </div>
  )
}

/** A sent user message, right-aligned like the real chat transcript. */
export function FeatureTipChatUserBubble({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[80%] rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-chat-foreground-strong">
        {children}
      </div>
    </div>
  )
}

/** The chat composer; without a `draft` it shows the real placeholder. */
export function FeatureTipChatComposer({
  draft,
  send
}: {
  draft: ReactNode
  send: ChatDemoSend
}): JSX.Element {
  const t = useTranslate()
  return (
    <div className="shrink-0 px-3 pt-1.5 pb-3">
      <div className="rounded-lg border border-chat-composer-border bg-chat-composer-surface p-1 shadow-xs">
        <div className="relative min-h-8 overflow-hidden px-2 py-0.5 whitespace-nowrap">
          {draft ?? (
            <span className="text-chat-foreground-faint">
              {t(
                'components.native-chat.composer.placeholder',
                'Ask anything, @ to mention files, / for commands'
              )}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1.5 text-chat-foreground-faint">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex size-6.5 shrink-0 items-center justify-center">
              <Plus className="size-3.5" />
            </span>
            <span className="flex h-5.5 min-w-0 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap">
              <Hand className="size-3 shrink-0" />
              <span className="truncate">{nativeChatPermissionModeLabel('ask', t)}</span>
              <ChevronDown className="size-3 shrink-0" />
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="flex h-5.5 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap text-chat-foreground">
              {CHAT_DEMO_MODEL}
              <ChevronDown className="size-3 text-chat-foreground-faint" />
            </span>
            <span className="relative size-6.5">
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-primary text-primary-foreground transition-[opacity,scale] duration-100',
                  send === 'empty' && 'opacity-50',
                  send === 'pressed' && 'scale-[0.88]',
                  send === 'stop' && 'opacity-0'
                )}
              >
                <ArrowUp className="size-3.5" />
              </span>
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-opacity duration-100',
                  send !== 'stop' && 'opacity-0'
                )}
              >
                <Square className="size-3 fill-current" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
