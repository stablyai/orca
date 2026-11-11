import { Button } from '@/components/ui/button'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { getLinearStateMarkerStyle } from '@/components/linear-state-pill-style'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import {
  linearLinkPreviewKey,
  loadLinearLinkPreview,
  readCachedLinearLinkPreview
} from './native-chat-linear-link-preview'
import { useNativeChatHoverPreview, type HoverPreviewState } from './use-native-chat-hover-preview'

export function useLinearIssuePreview(identifier: string): {
  state: HoverPreviewState<LinearIssue>
  retry: () => void
} {
  return useNativeChatHoverPreview(
    linearLinkPreviewKey(identifier),
    () => readCachedLinearLinkPreview(identifier),
    () => loadLinearLinkPreview(identifier)
  )
}

export function LinearStateDot({ color }: { color: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={getLinearStateMarkerStyle(color)}
    />
  )
}

/** Title, status, assignee and priority of a Linear issue, read through Orca's Linear connection. */
export function NativeChatLinearPeekBody({
  identifier
}: {
  identifier: string
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { state, retry } = useLinearIssuePreview(identifier)
  const issue = state.status === 'ready' ? state.value : null
  return (
    <div className="flex flex-col gap-1.5">
      {/* Known from the link, so the card has a header before Linear answers. */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono">{identifier}</span>
        {issue?.project ? <span className="min-w-0 truncate">· {issue.project.name}</span> : null}
        {issue ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <LinearStateDot color={issue.state.color} />
            {issue.state.name}
          </span>
        ) : null}
      </div>
      {issue ? (
        <>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">{issue.title}</div>
          {issue.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {issue.labels.slice(0, 4).map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-border px-1.5 text-3xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {issue.priority > 0 ? <LinearPriorityIcon priority={issue.priority} /> : null}
            <span className="min-w-0 truncate">
              {issue.assignee?.displayName ??
                t('components.native-chat.linearPeek.unassigned', 'Unassigned')}
            </span>
            {issue.updatedAt ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">
                  {t('components.native-chat.linearPeek.updated', 'updated {{time}}', {
                    time: formatRelativeTime(issue.updatedAt, intlLocale)
                  })}
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : state.status === 'loading' ? (
        <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
          <div className="h-3.5 w-11/12 rounded bg-muted" />
          <div className="h-3 w-1/3 rounded bg-muted" />
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{t('components.native-chat.linearPeek.unavailable', 'Preview unavailable.')}</span>
          <Button variant="link" size="xs" onClick={retry}>
            {t('components.native-chat.linearPeek.retry', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  )
}
