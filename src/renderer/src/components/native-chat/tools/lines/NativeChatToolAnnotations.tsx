import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { NativeChatToolCallBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatLinkClick } from '../../links/actions/native-chat-link-click-context'
import {
  type NativeChatMcpIdentity,
  formatToolDuration,
  mcpToolIdentity,
  toolWebSearchResults
} from '../../../../../../shared/native-chat/tools/native-chat-tool-identity'

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
      <span className="font-normal text-chat-foreground-faint">/</span>
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
  const t = useTranslate()
  const duration = formatToolDuration(block.durationMs, (value0) =>
    t('components.native-chat.tool.milliseconds', '{{value0}}ms', { value0 })
  )
  const exitCode = Number.isSafeInteger(block.exitCode) ? block.exitCode : undefined
  if (exitCode === undefined && duration === null) {
    return null
  }
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-sans text-xs tabular-nums text-chat-foreground-faint">
      {exitCode !== undefined ? (
        <span className={cn(exitCode !== 0 && 'text-destructive')}>
          {t('components.native-chat.tool.exitCode', 'exit {{value0}}', {
            value0: exitCode
          })}
        </span>
      ) : null}
      {duration ? <span>{duration}</span> : null}
    </span>
  )
}

export function NativeChatSearchResults({
  results
}: {
  results: NativeChatToolCallBlock['webSearchResults']
}): React.JSX.Element | null {
  const onLinkClick = useNativeChatLinkClick()
  const hits = toolWebSearchResults(results)
  if (hits.length === 0) {
    return null
  }
  return (
    <ul className="space-y-0.5 rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-xs text-chat-foreground">
      {hits.map((hit) => (
        <li key={hit.url} className="min-w-0">
          <a
            href={hit.url}
            target="_blank"
            rel="noreferrer"
            title={hit.url}
            className="block truncate text-chat-foreground underline underline-offset-2 hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <span className="ml-1.5 text-xs text-chat-foreground-faint">{hit.url}</span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  )
}
