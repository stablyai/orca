import { AtSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AntigravitySwarmPost } from '../../../../../shared/agent-session/antigravity-swarm-wire'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'

export function NativeChatSwarmFeed({
  channels,
  channelFilter,
  onlyMentions,
  searchQuery,
  posts,
  selectedPost,
  canMention,
  onSelectChannel,
  onToggleMentions,
  onSearchChange,
  onSelectPost,
  onMention
}: {
  channels: readonly string[]
  channelFilter: string | null
  onlyMentions: boolean
  searchQuery: string
  posts: readonly AntigravitySwarmPost[]
  selectedPost: AntigravitySwarmPost | null
  canMention: boolean
  onSelectChannel: (channel: string | null) => void
  onToggleMentions: () => void
  onSearchChange: (value: string) => void
  onSelectPost: (seq: number) => void
  onMention: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <section
      aria-label={t('components.native-chat.swarm.feedLabel', 'Board posts')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        {channels.length > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelectChannel(null)}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                channelFilter === null
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50'
              )}
            >
              {t('components.native-chat.swarm.allChannels', 'All')}
            </button>
            {channels.map((channel) => (
              <button
                key={channel}
                type="button"
                onClick={() => onSelectChannel(channelFilter === channel ? null : channel)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  channelFilter === channel
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                #{channel}
              </button>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          aria-pressed={onlyMentions}
          onClick={onToggleMentions}
          className={cn(
            'rounded px-1.5 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            onlyMentions
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-accent/50'
          )}
        >
          {t('components.native-chat.swarm.mentionsOnly', '@mentions')}
        </button>

        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('components.native-chat.swarm.searchPosts', 'Filter posts…')}
          className="ml-auto h-6 w-36 rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {posts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground">
          {t('components.native-chat.swarm.noPosts', 'No matching board posts.')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="scrollbar-sleek min-h-0 space-y-1 overflow-y-auto border-b border-border p-2">
            {posts.map((post) => {
              const active = selectedPost?.seq === post.seq
              return (
                <button
                  key={post.seq}
                  type="button"
                  onClick={() => onSelectPost(post.seq)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-border bg-accent'
                      : 'border-transparent hover:border-border hover:bg-accent/50'
                  )}
                >
                  <div className="flex items-center gap-1.5 text-2xs">
                    <span className="font-medium text-foreground">
                      {post.agent || t('components.native-chat.swarm.systemAgent', 'system')}
                    </span>
                    {post.channel ? (
                      <span className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                        #{post.channel}
                      </span>
                    ) : null}
                    {post.all ? (
                      <span className="rounded bg-muted px-1 py-0.5 text-3xs text-foreground">
                        {t('components.native-chat.swarm.allMention', '@all')}
                      </span>
                    ) : null}
                    {post.mentions.map((mention) => (
                      <span
                        key={mention}
                        className="rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground"
                      >
                        @{mention}
                      </span>
                    ))}
                    <span className="ml-auto shrink-0 text-muted-foreground">#{post.seq}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{post.text}</p>
                </button>
              )
            })}
          </div>

          {selectedPost ? (
            <div className="scrollbar-sleek min-h-0 overflow-y-auto p-3">
              <div className="mb-2 flex items-center gap-2 text-2xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selectedPost.agent || t('components.native-chat.swarm.systemAgent', 'system')}
                </span>
                <span>#{selectedPost.seq}</span>
                {selectedPost.time ? <span>{selectedPost.time}</span> : null}
                {selectedPost.channel ? <span>#{selectedPost.channel}</span> : null}
                {canMention && selectedPost.agent ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    onClick={() => onMention(selectedPost.agent)}
                  >
                    <AtSign className="size-3" />
                    <span>{selectedPost.agent}</span>
                  </Button>
                ) : null}
              </div>
              <NativeChatMarkdown
                content={selectedPost.text}
                variant="document"
                linkifyFilePaths
                rowKey={`swarm-post-${selectedPost.seq}`}
                className="text-sm leading-relaxed text-foreground"
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
