import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import React, { useRef, useEffect } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { CheckCircle2, AlertCircle, Clock3, Minus } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { getChecksPillTone, getChecksLabel } from '../../task-page-checks-pill'
export function PRChecksCell({
  item,
  onOpen,
  onLoadChecks
}: {
  item: GitHubWorkItem
  onOpen: () => void
  onLoadChecks: () => void
}): React.JSX.Element {
  const t = useTranslate()
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
        {t('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }
  const outcome = getProviderChecksOutcome(item.checksSummary)
  const Icon =
    outcome === 'success'
      ? CheckCircle2
      : outcome === 'failure'
        ? AlertCircle
        : outcome === 'pending'
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
          <span className="truncate">{getChecksLabel(item, t)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {t('auto.components.TaskPage.995dd6af9b', 'Open PR checks')}
      </TooltipContent>
    </Tooltip>
  )
}
