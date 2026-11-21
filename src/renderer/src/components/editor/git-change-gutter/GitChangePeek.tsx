import { useLayoutEffect } from 'react'
import { ChevronDown, ChevronUp, Copy, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { GitChangePeekModel } from './use-monaco-git-change-peek'

function PeekAction({
  label,
  onClick,
  disabled = false,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function GitChangePeek({
  originalSegments,
  total,
  onPrevious,
  onNext,
  onCopy,
  onRevert,
  onClose,
  onContentResize
}: Omit<GitChangePeekModel, 'domNode'>): React.JSX.Element {
  const t = useTranslate()
  const hasOriginalLines = originalSegments.length > 0
  // Monaco positions the widget from its rendered size, which changes with the shown hunk.
  useLayoutEffect(() => {
    onContentResize()
  })

  return (
    <div className="orca-git-change-peek overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-floating">
      <div className="flex items-center gap-1 px-2 py-1.5 font-sans text-muted-foreground">
        <PeekAction
          label={t('editorGitChangePeek.previous', 'Previous change')}
          onClick={onPrevious}
          disabled={total < 2}
        >
          <ChevronUp />
        </PeekAction>
        <PeekAction
          label={t('editorGitChangePeek.next', 'Next change')}
          onClick={onNext}
          disabled={total < 2}
        >
          <ChevronDown />
        </PeekAction>
        <PeekAction label={t('editorGitChangePeek.revert', 'Revert change')} onClick={onRevert}>
          <Undo2 />
        </PeekAction>
        {hasOriginalLines ? (
          <PeekAction label={t('editorGitChangePeek.copy', 'Copy original lines')} onClick={onCopy}>
            <Copy />
          </PeekAction>
        ) : null}
        <PeekAction label={t('editorGitChangePeek.close', 'Close')} onClick={onClose}>
          <X />
        </PeekAction>
      </div>
      {hasOriginalLines ? (
        <div className="orca-git-change-peek-original scrollbar-editor max-h-60 overflow-auto border-t border-border py-1.5 pr-3">
          <pre className="m-0 select-text">
            {originalSegments.map((segment, index) =>
              segment.removed ? (
                <span key={index} className="orca-git-change-peek-removed">
                  {segment.text}
                </span>
              ) : (
                segment.text
              )
            )}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
