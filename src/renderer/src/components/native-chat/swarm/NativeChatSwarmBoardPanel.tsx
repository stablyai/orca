import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Circle, Loader2, Network, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { AntigravitySwarmPost } from '../../../../../shared/agent-session/antigravity-swarm-wire'
import { NativeChatSwarmFeed } from './NativeChatSwarmFeed'
import { NativeChatSwarmMemberTranscript } from './NativeChatSwarmMemberTranscript'
import { NativeChatSwarmRoster } from './NativeChatSwarmRoster'
import type { NativeChatSwarmBoardState } from './use-native-chat-swarm-board'

function postMatchesFilter(
  post: AntigravitySwarmPost,
  args: {
    member: string | null
    channel: string | null
    onlyMentions: boolean
    query: string
  }
): boolean {
  if (post.control) {
    return false
  }
  if (args.channel && (post.channel ?? 'main') !== args.channel) {
    return false
  }
  if (args.member) {
    const involves = post.agent === args.member || post.all || post.mentions.includes(args.member)
    if (!involves) {
      return false
    }
  }
  if (args.onlyMentions && !post.all && post.mentions.length === 0) {
    return false
  }
  if (args.query) {
    const q = args.query.toLowerCase()
    const hay = `${post.agent}\n${post.text}\n${post.channel ?? ''}`.toLowerCase()
    if (!hay.includes(q)) {
      return false
    }
  }
  return true
}

export function NativeChatSwarmBoardPanel({
  board,
  canMention,
  onMention,
  onCloseFocus
}: {
  board: NativeChatSwarmBoardState
  canMention: boolean
  onMention: (name: string) => void
  onCloseFocus: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const rootRef = useRef<HTMLElement>(null)
  const [memberFilter, setMemberFilter] = useState<string | null>(null)
  const [channelFilter, setChannelFilter] = useState<string | null>(null)
  const [onlyMentions, setOnlyMentions] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  const snapshot = board.snapshot

  useEffect(() => {
    if (!board.isOpen) {
      return
    }
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) {
      root.focus({ preventScroll: true })
    }
  }, [board.isOpen, board.selectedConversationId])

  useEffect(() => {
    if (!board.isOpen) {
      return
    }
    const pane = rootRef.current?.closest<HTMLElement>('[data-native-chat-root], .pane')
    if (!pane) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isImeOwnedKeyboardEvent(event) ||
        hasVisibleOverlay()
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (board.selectedConversationId) {
        board.selectMemberConversation(null)
        return
      }
      board.close()
      onCloseFocus()
    }
    pane.addEventListener('keydown', onKeyDown, true)
    return () => pane.removeEventListener('keydown', onKeyDown, true)
  }, [board, onCloseFocus])

  const selectedMember = useMemo(
    () =>
      board.selectedConversationId && snapshot
        ? (snapshot.members.find((m) => m.conversationId === board.selectedConversationId) ?? null)
        : null,
    [board.selectedConversationId, snapshot]
  )

  const filteredPosts = useMemo(() => {
    if (!snapshot) {
      return []
    }
    return snapshot.messages
      .filter((post) =>
        postMatchesFilter(post, {
          member: memberFilter,
          channel: channelFilter,
          onlyMentions,
          query: searchQuery.trim()
        })
      )
      .toReversed()
  }, [channelFilter, memberFilter, onlyMentions, searchQuery, snapshot])

  const selectedPost = useMemo(
    () =>
      selectedSeq !== null
        ? (filteredPosts.find((post) => post.seq === selectedSeq) ?? filteredPosts[0] ?? null)
        : (filteredPosts[0] ?? null),
    [filteredPosts, selectedSeq]
  )

  if (!board.isOpen) {
    return null
  }

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      aria-label={snapshot?.title ?? t('components.native-chat.swarm.boardTitle', 'Swarm Board')}
      data-native-chat-swarm-board=""
      data-native-chat-typing-redirect-ignore="true"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="pointer-events-auto absolute inset-x-3 bottom-3 top-[calc(var(--orca-pane-title-height)+var(--spacing)*2)] z-[16] flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-floating focus:outline-none"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Network className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">
            {snapshot?.title ?? t('components.native-chat.swarm.boardTitle', 'Swarm Board')}
          </span>
          {snapshot ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
              #{snapshot.headSeq}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={board.refresh}
            aria-label={t('components.native-chat.swarm.refresh', 'Refresh board')}
          >
            <RefreshCw className={cn('size-3.5', board.loading && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              board.close()
              onCloseFocus()
            }}
            aria-label={t('components.native-chat.swarm.close', 'Close')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {board.error ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 truncate">{board.error}</span>
          <Button type="button" variant="outline" size="xs" onClick={board.refresh}>
            {t('components.native-chat.swarm.retry', 'Retry')}
          </Button>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          {board.loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoadingSpinner className="size-3.5" />
              <span>{t('components.native-chat.swarm.loading', 'Loading swarm board…')}</span>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">
                {t('components.native-chat.swarm.emptyTitle', 'No active swarm in this chat')}
              </p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t(
                  'components.native-chat.swarm.emptyHint',
                  'Start one with /swarm <task> to coordinate workers, track their progress, and read board posts here.'
                )}
              </p>
            </>
          )}
        </div>
      ) : selectedMember ? (
        <NativeChatSwarmMemberTranscript
          member={selectedMember}
          transcript={board.transcript}
          loading={board.transcriptLoading}
          canMention={canMention}
          onBack={() => board.selectMemberConversation(null)}
          onRefresh={board.refreshTranscript}
          onMention={onMention}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {snapshot.plan?.steps && snapshot.plan.steps.length > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
              <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('components.native-chat.swarm.planLabel', 'Plan')}
              </span>
              {snapshot.plan.steps.map((step) => (
                <span
                  key={`${step.title}-${step.owner ?? ''}-${step.detail ?? ''}-${step.status ?? ''}`}
                  className="inline-flex max-w-56 items-center gap-1 truncate rounded border border-border bg-background/70 px-1.5 py-0.5 text-2xs text-foreground"
                  title={step.owner ? `${step.title} (${step.owner})` : step.title}
                >
                  {step.status === 'completed' ? (
                    <CheckCircle2 className="size-3 shrink-0 text-muted-foreground" />
                  ) : step.status === 'in_progress' ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-foreground" />
                  ) : (
                    <Circle className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{step.title}</span>
                </span>
              ))}
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,15rem)_1fr]">
            <NativeChatSwarmRoster
              members={snapshot.members}
              memberFilter={memberFilter}
              canMention={canMention}
              onToggleFilter={(name) => setMemberFilter((prev) => (prev === name ? null : name))}
              onClearFilter={() => setMemberFilter(null)}
              onOpenConversation={(conversationId) =>
                board.selectMemberConversation(conversationId)
              }
              onMention={onMention}
            />
            <NativeChatSwarmFeed
              channels={snapshot.channels}
              channelFilter={channelFilter}
              onlyMentions={onlyMentions}
              searchQuery={searchQuery}
              posts={filteredPosts}
              selectedPost={selectedPost}
              canMention={canMention}
              onSelectChannel={setChannelFilter}
              onToggleMentions={() => setOnlyMentions((prev) => !prev)}
              onSearchChange={setSearchQuery}
              onSelectPost={setSelectedSeq}
              onMention={onMention}
            />
          </div>
        </div>
      )}
    </aside>
  )
}
