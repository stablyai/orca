import { translate } from '@/i18n/i18n'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'
import {
  type NativeChatMcpIdentity,
  formatToolDuration,
  mcpToolIdentity,
  toolWebSearchResults
} from '../../../../shared/native-chat-tool-identity'

export function NativeChatToolName({
  name,
  mcpIdentity
}: {
  name: string
  mcpIdentity?: NativeChatMcpIdentity
}): React.JSX.Element {
  const identity = mcpToolIdentity(name, mcpIdentity)
  return identity ? (
    <span title={name} className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{identity.server}</span>
      <span className="font-normal text-muted-foreground">/</span>
      <span className="truncate font-normal">{identity.tool}</span>
    </span>
  ) : (
    <>{name}</>
  )
}

export function NativeChatCommandMetadata({
  block
}: {
  block: NativeChatToolCallBlock
}): React.JSX.Element | null {
  const duration = formatToolDuration(block.durationMs, (value0) =>
    translate('components.native-chat.tool.milliseconds', '{{value0}}ms', { value0 })
  )
  const exitCode = Number.isSafeInteger(block.exitCode) ? block.exitCode : undefined
  if (exitCode === undefined && duration === null) {
    return null
  }
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[11px] text-muted-foreground">
      {exitCode !== undefined ? (
        <span className={cn(exitCode !== 0 && 'text-destructive')}>
          {translate('components.native-chat.tool.exitCode', 'exit {{value0}}', {
            value0: exitCode
          })}
        </span>
      ) : null}
      {duration ? <span>{duration}</span> : null}
    </span>
  )
}

export function NativeChatSearchResults({
  results,
  onLinkClick
}: {
  results: NativeChatToolCallBlock['webSearchResults']
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const hits = toolWebSearchResults(results)
  if (hits.length === 0) {
    return null
  }
  return (
    <ul className="ml-5 space-y-0.5 text-xs">
      {hits.map((hit) => (
        <li key={hit.url} className="min-w-0">
          <a
            href={hit.url}
            target="_blank"
            rel="noreferrer"
            title={hit.url}
            className="block truncate text-foreground/80 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation()
              onLinkClick?.(event, hit.url)
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.stopPropagation()
                onLinkClick?.(event, hit.url)
              }
            }}
          >
            {hit.title}
            {hit.title !== hit.url ? (
              <span className="ml-1.5 text-[11px] text-muted-foreground">{hit.url}</span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  )
}
