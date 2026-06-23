import type { PRCommentGroupActionState } from '@/lib/pr-comment-action-state'
import { cn } from '@/lib/utils'

/** PR comment sidebar typography and layout variants. */
export type PRCommentPresentationVariant = 'flat' | 'cards' | 'focus'

export const DEFAULT_PR_COMMENT_PRESENTATION_VARIANT: PRCommentPresentationVariant = 'cards'

export const PR_COMMENT_PRESENTATION_VARIANTS: PRCommentPresentationVariant[] = [
  'flat',
  'cards',
  'focus'
]

const STORAGE_KEY = 'orca:pr-comment-presentation'

export type PRCommentPresentationClasses = {
  variant: PRCommentPresentationVariant
  useCardLayout: boolean
  list: string
  group: string
  groupStandalone: string
  groupThread: string
  commentRow: string
  commentRowReply: string
  commentHeader: string
  commentHeaderReply: string
  commentBody: string
  commentBodyReply: string
  commentBodyMarkdown: string
  author: string
  authorResolved: string
  avatar: string
  avatarReply: string
  botBadge: string
  pathBadge: string
  time: string
  resolvedContainer: string
  repliesContainer: string
  resolvedSection: string
  resolvedSectionTrigger: string
  resolvedSectionContent: string
  sectionHeader: string
  sectionHeaderLabel: string
  sectionCount: string
  audienceTabs: string
  audienceTab: string
  audienceTabActive: string
  sectionTriageLabel: string
  statusBadgeOpen: string
  statusBadgeResolved: string
  statusBadgeQueued: string
  commentHeaderPrimary: string
  commentHeaderMeta: string
  /** Indents the card meta row when a selection checkbox precedes the avatar. */
  commentHeaderMetaWithSelection: string
  groupOpen: string
  groupQueued: string
  groupResolved: string
}

export function getPRCommentGroupSurfaceClasses(
  presentation: PRCommentPresentationClasses,
  actionState: PRCommentGroupActionState,
  options?: { queued?: boolean }
): string {
  const classes = [presentation.group]
  if (options?.queued) {
    classes.push(presentation.groupQueued)
    // Why: queued selection already owns the leading affordance; stacking the
    // open rail next to its checkbox makes the card edge visually crowded.
    return classes.join(' ')
  }
  if (actionState === 'open' && presentation.groupOpen) {
    classes.push(presentation.groupOpen)
  } else if (actionState === 'resolved') {
    classes.push(presentation.groupResolved)
  }
  return classes.join(' ')
}

const MARKDOWN_BASE =
  'break-words [&_p]:my-1.5 [&_pre]:max-h-none [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_table]:w-full [&_table]:max-w-full'

// Why: in light mode card and canvas are both #fff, so border-border alone disappears.
// overflow-clip preserves rounded clipping without letting focused row actions scroll content.
const COMMENT_CARD_SURFACE =
  'overflow-clip rounded-lg border border-border bg-secondary shadow-xs dark:bg-card dark:shadow-none'

const COMMENT_CARD_DIVIDER = 'border-border dark:border-border/60'

// Why: placeholders used bg-muted on bg-secondary cards — same grey in light mode.
const COMMENT_AVATAR =
  'shrink-0 rounded-full border border-border bg-background object-cover shadow-xs dark:shadow-none'

const RESOLVED_SECTION_LABEL =
  'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

const RESOLVED_SECTION_TRIGGER = cn(
  RESOLVED_SECTION_LABEL,
  'rounded-none border-0 bg-transparent px-3 py-2 shadow-none hover:bg-accent/40 hover:text-foreground hover:no-underline'
)

function isVariant(value: string | null): value is PRCommentPresentationVariant {
  return value === 'flat' || value === 'cards' || value === 'focus'
}

/** Resolve the active variant. In dev, override with
 *  localStorage.setItem('orca:pr-comment-presentation', 'cards' | 'flat' | 'focus'). */
export function resolvePRCommentPresentationVariant(): PRCommentPresentationVariant {
  if (typeof window === 'undefined') {
    return DEFAULT_PR_COMMENT_PRESENTATION_VARIANT
  }
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isVariant(stored)) {
    return stored
  }
  return DEFAULT_PR_COMMENT_PRESENTATION_VARIANT
}

export function getPRCommentPresentationClasses(
  variant: PRCommentPresentationVariant = resolvePRCommentPresentationVariant()
): PRCommentPresentationClasses {
  if (variant === 'flat') {
    return {
      variant,
      useCardLayout: false,
      list: 'py-1',
      group: 'py-0.5',
      groupStandalone: '',
      groupThread: 'py-0.5',
      commentRow: 'py-1.5 px-3 transition-colors hover:bg-accent/40',
      commentRowReply: 'pl-7 pr-3',
      commentHeader: 'flex min-w-0 items-center gap-1.5',
      commentHeaderReply: 'flex min-w-0 items-center gap-1.5',
      commentBody: 'mt-1 pl-[22px] text-[11px] leading-snug text-muted-foreground',
      commentBodyReply: 'mt-1 pl-5 text-[11px] leading-snug text-muted-foreground',
      commentBodyMarkdown: MARKDOWN_BASE,
      author: 'shrink-0 text-[11px] font-semibold text-foreground',
      authorResolved: 'text-muted-foreground',
      avatar: `size-4 ${COMMENT_AVATAR}`,
      avatarReply: `size-3.5 ${COMMENT_AVATAR}`,
      botBadge:
        'shrink-0 rounded border border-border bg-accent/40 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground',
      pathBadge: 'min-w-0 flex-1 truncate text-[10px] font-mono text-muted-foreground/60',
      time: 'hidden',
      resolvedContainer: 'opacity-50',
      repliesContainer: 'ml-3 border-l-2 border-border/50',
      resolvedSection: 'mt-1 border-t border-border pt-1',
      resolvedSectionTrigger: RESOLVED_SECTION_TRIGGER,
      resolvedSectionContent: 'flex flex-col gap-2 pb-1 pt-1',
      sectionHeader: 'flex flex-col gap-2.5 border-b border-border px-3 py-2.5',
      sectionHeaderLabel: 'text-[11px] font-medium text-foreground',
      sectionCount: 'text-[10px] text-muted-foreground',
      audienceTabs: 'grid grid-cols-3 rounded-md border border-border bg-background p-0.5',
      audienceTab:
        'flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors',
      audienceTabActive: 'bg-muted text-foreground',
      sectionTriageLabel: cn('px-3 pt-2', RESOLVED_SECTION_LABEL),
      statusBadgeOpen:
        'shrink-0 rounded border border-status-success-border bg-status-success-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-success',
      statusBadgeResolved:
        'shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
      statusBadgeQueued:
        'shrink-0 rounded border border-ring/40 bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground',
      commentHeaderPrimary: 'flex min-w-0 items-center gap-1.5',
      commentHeaderMeta: '',
      commentHeaderMetaWithSelection: '',
      groupOpen: 'border-l-2 border-l-status-success',
      groupQueued: 'ring-1 ring-ring/50',
      groupResolved: ''
    }
  }

  const isFocus = variant === 'focus'
  const bodySize = isFocus ? 'text-[14px] leading-relaxed' : 'text-[13px] leading-relaxed'
  const authorSize = isFocus ? 'text-[14px]' : 'text-[13px]'
  const listGap = isFocus ? 'gap-3' : 'gap-2'
  const bodyPadding = isFocus ? 'px-4 py-3' : 'px-4 py-2.5'
  const headerPadding = isFocus ? 'px-3.5 py-2.5' : 'px-3 py-2'
  const metaIndent = isFocus ? 'pl-8' : 'pl-7'

  return {
    variant,
    useCardLayout: true,
    list: `flex flex-col ${listGap} px-3 py-2`,
    group: COMMENT_CARD_SURFACE,
    groupStandalone: '',
    groupThread: '',
    commentRow: 'group/comment',
    commentRowReply: `border-t ${COMMENT_CARD_DIVIDER} bg-muted/25 dark:bg-muted/10`,
    commentHeader: `flex flex-col gap-1 border-b ${COMMENT_CARD_DIVIDER} ${headerPadding}`,
    commentHeaderReply: `flex min-w-0 items-center gap-2 ${headerPadding}`,
    commentBody: `${bodyPadding} ${bodySize} text-foreground`,
    commentBodyReply: `${bodyPadding} ${bodySize} text-foreground`,
    commentBodyMarkdown: MARKDOWN_BASE,
    author: `min-w-0 flex-1 truncate ${authorSize} font-semibold text-foreground`,
    authorResolved: 'text-muted-foreground',
    avatar: `size-5 ${COMMENT_AVATAR}`,
    avatarReply: `size-4 ${COMMENT_AVATAR}`,
    botBadge:
      'shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
    pathBadge: 'min-w-0 max-w-full truncate font-mono text-muted-foreground',
    time: 'shrink-0 text-[11px] text-muted-foreground',
    resolvedContainer: 'opacity-60',
    repliesContainer: 'flex flex-col',
    resolvedSection: 'mt-1 border-t border-border pt-1',
    resolvedSectionTrigger: RESOLVED_SECTION_TRIGGER,
    resolvedSectionContent: 'flex flex-col gap-2 pb-1 pt-1',
    sectionHeader: 'flex flex-col gap-2.5 border-b border-border px-3 py-2.5',
    sectionHeaderLabel: 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground',
    sectionCount:
      'rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-foreground',
    audienceTabs: 'grid grid-cols-3 rounded-md border border-border bg-background p-0.5',
    audienceTab:
      'flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors',
    audienceTabActive: 'bg-muted text-foreground shadow-xs',
    sectionTriageLabel: cn('px-3 pt-1', RESOLVED_SECTION_LABEL),
    statusBadgeOpen:
      'shrink-0 rounded border border-status-success-border bg-status-success-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-success',
    statusBadgeResolved:
      'shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
    statusBadgeQueued:
      'shrink-0 rounded border border-ring/40 bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground',
    commentHeaderPrimary: 'flex min-w-0 items-center gap-2',
    commentHeaderMeta: cn(
      metaIndent,
      'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground'
    ),
    // Why: checkbox (16px) + gap-2 sits before the avatar row the meta row already indents past.
    commentHeaderMetaWithSelection: cn(
      isFocus ? 'pl-[3.5rem]' : 'pl-[3.25rem]',
      'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground'
    ),
    // Why: open state is conveyed by the status badge; a green card rail reads noisy in the sidebar.
    groupOpen: '',
    groupQueued: 'ring-1 ring-ring/50',
    groupResolved: ''
  }
}
