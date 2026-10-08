import type React from 'react'
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GitHubCalloutKind } from '@/lib/remark-github-callouts'

const CALLOUT_PRESENTATIONS: Record<
  GitHubCalloutKind,
  { Icon: LucideIcon; label: () => string; borderClassName: string; titleClassName: string }
> = {
  note: {
    Icon: Info,
    label: () => translate('components.markdown-callout.note', 'Note'),
    borderClassName: 'border-callout-note',
    titleClassName: 'text-callout-note'
  },
  tip: {
    Icon: Lightbulb,
    label: () => translate('components.markdown-callout.tip', 'Tip'),
    borderClassName: 'border-status-success',
    titleClassName: 'text-status-success'
  },
  important: {
    Icon: MessageSquareWarning,
    label: () => translate('components.markdown-callout.important', 'Important'),
    borderClassName: 'border-callout-important',
    titleClassName: 'text-callout-important'
  },
  warning: {
    Icon: TriangleAlert,
    label: () => translate('components.markdown-callout.warning', 'Warning'),
    borderClassName: 'border-status-warning',
    titleClassName: 'text-status-warning'
  },
  caution: {
    Icon: OctagonAlert,
    label: () => translate('components.markdown-callout.caution', 'Caution'),
    borderClassName: 'border-destructive',
    titleClassName: 'text-destructive'
  }
}

// Why: a <div>, not a <blockquote> — quote styles mute the body, and a callout's body is ordinary text.
export function MarkdownGitHubCallout({
  kind,
  className,
  children
}: {
  kind: GitHubCalloutKind
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { Icon, label, borderClassName, titleClassName } = CALLOUT_PRESENTATIONS[kind]
  return (
    <div role="note" data-callout={kind} className={cn(borderClassName, className)}>
      <div className={cn('flex items-center gap-1.5 font-medium', titleClassName)}>
        <Icon aria-hidden className="size-[1em] shrink-0" />
        {label()}
      </div>
      {children}
    </div>
  )
}
