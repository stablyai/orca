import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import React, { useRef, useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { CheckCircle2, AlertCircle, AlertTriangle, Clock3, Minus } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getChecksPillTone, getChecksLabel } from '@/components/task-page-checks-pill'
import { getProviderChecksPresentationState } from '../../../../../shared/provider-check-summary'
export function PRChecksCell({
  item,
  onOpen,
  onLoadChecks
}: {
  item: GitHubWorkItem
  onOpen: () => void
  onLoadChecks: () => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (item.type !== 'pr' || item.checksSummary) {
      return
    }
    const node = triggerRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      return
    }
    let requested = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (requested || !entries.some((entry) => entry.isIntersecting)) {
          return
        }
        requested = true
        onLoadChecks()
        observer.disconnect()
      },
      {
        rootMargin: '160px 0px'
      }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.checksSummary, item.type, onLoadChecks])
  if (item.type !== 'pr') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }
  const summary = item.checksSummary
  const presentationState = getProviderChecksPresentationState(summary)
  const Icon =
    presentationState === 'success'
      ? CheckCircle2
      : presentationState === 'failure'
        ? AlertCircle
        : presentationState === 'action_required'
          ? AlertTriangle
          : presentationState === 'pending'
            ? Clock3
            : Minus
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onFocus={onLoadChecks}
          onMouseEnter={onLoadChecks}
          onClick={(event) => {
            event.stopPropagation()
            onLoadChecks()
            onOpen()
          }}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-110',
            getChecksPillTone(item)
          )}
        >
          <Icon className="size-3" />
          <span className="truncate">{getChecksLabel(item)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.components.TaskPage.995dd6af9b', 'Open PR checks')}
      </TooltipContent>
    </Tooltip>
  )
}
