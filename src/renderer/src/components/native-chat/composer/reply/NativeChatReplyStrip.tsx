import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Reply, X } from 'lucide-react'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import {
  cancelNativeChatReplyTarget,
  nativeChatReplyWasCancelled,
  useNativeChatReplyTarget,
  type NativeChatReplyTarget
} from './native-chat-reply-target'
import {
  NATIVE_CHAT_MESSAGES_CHANGED_EVENT,
  requestNativeChatMessageReveal
} from './native-chat-reply-context'

const ANNOUNCE_DELAY_MS = 100

/** "Replying to …" at the top of the message box: names the message the next send answers. */
export function NativeChatReplyStrip({
  scopeKey,
  agent,
  onDone
}: {
  scopeKey: string
  agent?: string
  /** Hands the user back to the message box after Cancel. */
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const target = useNativeChatReplyTarget(scopeKey)
  const agentName = agent
    ? formatAgentTypeLabel(agent)
    : t('components.native-chat.reply.agentFallback', 'Agent')
  // Whole sentences per author, so each language words "your message" and a name its own way.
  const words = !target
    ? null
    : target.author === 'user'
      ? {
          label: t('components.native-chat.reply.replyingToYouLabel', 'Replying to your message'),
          heading: t(
            'components.native-chat.reply.replyingToYouName',
            'Replying to <name>your message</name>'
          )
        }
      : {
          label: t('components.native-chat.reply.replyingToLabel', 'Replying to {{name}}', {
            name: agentName
          }),
          heading: t(
            'components.native-chat.reply.replyingToName',
            'Replying to <name>{{name}}</name>',
            {
              name: agentName
            }
          )
        }
  const announcement = words
    ? words.label
    : // Only a user's cancel is announced; a send that uses the reply ends it silently.
      nativeChatReplyWasCancelled(scopeKey)
      ? t('components.native-chat.reply.cancelled', 'Reply cancelled')
      : ''
  const liveRef = useRef<HTMLSpanElement>(null)
  const targetId = target?.id
  useEffect(() => {
    const live = liveRef.current
    if (!live) {
      return
    }
    // A newly picked reply may have the same words as the last; clearing first, then speaking in a
    // later task, makes screen readers hear it again.
    live.textContent = ''
    const timer = setTimeout(() => {
      live.textContent = announcement
    }, ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [announcement, targetId])
  return (
    <>
      {/* Always mounted, so screen readers hear each change rather than a region appearing. */}
      <span ref={liveRef} className="sr-only" role="status" aria-live="polite" />
      {target && words ? (
        <ReplyStripRow
          key={target.id}
          words={words}
          target={target}
          onCancel={() => cancelNativeChatReplyTarget(scopeKey)}
          onDone={onDone}
        />
      ) : null}
    </>
  )
}

function ReplyStripRow({
  words,
  target,
  onCancel,
  onDone
}: {
  words: { label: string; heading: string }
  target: NativeChatReplyTarget
  onCancel: () => void
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const ref = useRef<HTMLDivElement>(null)
  // A rewind or clear can take the message out of this chat.
  const [available, setAvailable] = useState(true)
  // Passive, so the transcript's layout-time answer is already listening; asked again whenever
  // the transcript's messages change, so a removed or returning original shows correctly.
  useEffect(() => {
    const probe = (): void =>
      setAvailable(requestNativeChatMessageReveal(ref.current, target, { probe: true }))
    probe()
    const root = ref.current?.closest('[data-native-chat-root]')
    root?.addEventListener(NATIVE_CHAT_MESSAGES_CHANGED_EVENT, probe)
    return () => root?.removeEventListener(NATIVE_CHAT_MESSAGES_CHANGED_EVENT, probe)
  }, [target])
  const snippet = target.excerpt.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const showOriginal = t('components.native-chat.reply.showOriginal', 'Show the original message')
  const unavailable = t('components.native-chat.reply.originalUnavailable', 'Message unavailable')
  const cancelLabel = t('components.native-chat.reply.cancel', 'Cancel reply')
  return (
    <div
      ref={ref}
      role="group"
      aria-label={words.label}
      className="mb-1.5 flex min-w-0 items-center gap-1.5 rounded-lg bg-muted/70 py-1 pr-1 pl-2 text-xs text-muted-foreground"
    >
      <Reply aria-hidden className="size-3.5 shrink-0" />
      {/* One sentence, so each language orders "Replying to" and the name its own way. */}
      <span className="shrink-0">
        <Trans
          i18n={i18n}
          defaults={words.heading}
          components={{ name: <span className="font-medium text-foreground" /> }}
        />
      </span>
      {available ? (
        <button
          type="button"
          title={showOriginal}
          aria-label={`${showOriginal}: ${snippet}`}
          onClick={(event) => {
            // detail 0: activated from the keyboard (Enter or Space), not a pointer click.
            const fromKeyboard = event.detail === 0
            if (
              !requestNativeChatMessageReveal(ref.current, target, {
                probe: false,
                focus: fromKeyboard
              })
            ) {
              setAvailable(false)
            }
          }}
          className={cn(
            'group/snip flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left text-muted-foreground',
            'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
        >
          <span className="truncate group-hover/snip:underline group-focus-visible/snip:underline">
            {snippet}
          </span>
          <ArrowUpRight aria-hidden className="size-3 shrink-0 opacity-70" />
        </button>
      ) : (
        // The cue never truncates; only the snippet after it does, and its words stay in the title.
        <span
          className="flex min-w-0 flex-1 items-center gap-1"
          title={snippet ? `${unavailable}: ${snippet}` : unavailable}
        >
          <span className="shrink-0 italic">{unavailable}</span>
          {snippet ? <span className="min-w-0 truncate">· {snippet}</span> : null}
        </span>
      )}
      <button
        type="button"
        aria-label={cancelLabel}
        title={cancelLabel}
        onClick={() => {
          onCancel()
          onDone()
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
