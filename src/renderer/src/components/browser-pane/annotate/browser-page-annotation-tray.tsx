import { useEffect, useState } from 'react'
import { CircleCheck, Copy, MessageSquarePlus, Pencil, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import {
  GRAB_BUDGET,
  type BrowserAnnotationIntent,
  type BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import { BROWSER_ANNOTATION_INTENT_OPTIONS } from '../describe-page/browser-annotation-geometry'
import { BrowserAnnotationSendMenuContent } from './BrowserAnnotationSendMenuContent'
import { preventAgentSendTargetOutsideDismiss } from './prevent-agent-send-target-outside-dismiss'

export function BrowserPageAnnotationTray({
  browserAnnotations,
  annotationTraySendOpen,
  handleAnnotationTraySendOpenChange,
  worktreeId,
  activeGroupId,
  browserAnnotationsPrompt,
  handleBrowserAnnotationsSentToAgent,
  handleCopyBrowserAnnotations,
  browserAnnotationsCopied,
  handleClearBrowserAnnotations,
  handleDeleteBrowserAnnotation,
  handleUpdateBrowserAnnotation
}: {
  browserAnnotations: BrowserPageAnnotation[]
  annotationTraySendOpen: boolean
  handleAnnotationTraySendOpenChange: (open: boolean) => void
  worktreeId: string
  activeGroupId: string | undefined
  browserAnnotationsPrompt: string
  handleBrowserAnnotationsSentToAgent: () => void
  handleCopyBrowserAnnotations: () => void
  browserAnnotationsCopied: boolean
  handleClearBrowserAnnotations: () => void
  handleDeleteBrowserAnnotation: (annotationId: string) => void
  handleUpdateBrowserAnnotation: (
    annotationId: string,
    comment: string,
    intent: BrowserAnnotationIntent
  ) => void
}): React.JSX.Element {
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const [editComment, setEditComment] = useState('')
  const [editIntent, setEditIntent] = useState<BrowserAnnotationIntent>('change')

  // Why: a delete or clear while a row is mid-edit must not leave edit state pointing at nothing.
  useEffect(() => {
    if (
      editingAnnotationId &&
      !browserAnnotations.some((annotation) => annotation.id === editingAnnotationId)
    ) {
      setEditingAnnotationId(null)
    }
  }, [browserAnnotations, editingAnnotationId])

  const handleStartEdit = (annotation: BrowserPageAnnotation): void => {
    setEditingAnnotationId(annotation.id)
    setEditComment(annotation.comment)
    setEditIntent(annotation.intent)
  }

  const handleCancelEdit = (): void => {
    setEditingAnnotationId(null)
  }

  const handleSaveEdit = (): void => {
    const trimmed = editComment.trim()
    if (!trimmed || !editingAnnotationId) {
      return
    }
    handleUpdateBrowserAnnotation(editingAnnotationId, trimmed, editIntent)
    setEditingAnnotationId(null)
  }

  return (
    <div className="absolute right-3 bottom-3 z-30 flex max-h-[45%] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <MessageSquarePlus className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm font-medium">
          {browserAnnotations.length === 1
            ? translate(
                'auto.components.browser.pane.BrowserPane.ea6af700da',
                '{{value0}} annotation',
                { value0: browserAnnotations.length }
              )
            : translate(
                'auto.components.browser.pane.BrowserPane.c13693fe27',
                '{{value0}} annotations',
                { value0: browserAnnotations.length }
              )}
        </div>
        <DropdownMenu
          modal={false}
          open={annotationTraySendOpen}
          onOpenChange={handleAnnotationTraySendOpenChange}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline" className="gap-1.5">
                  <Send className="size-3" />
                  {translate('auto.components.browser.pane.BrowserPane.ac39b9366b', 'Send')}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.browser.pane.BrowserPane.95af781091',
                'Send feedback to an agent'
              )}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className="min-w-[180px]"
            onInteractOutside={preventAgentSendTargetOutsideDismiss}
            onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
          >
            <BrowserAnnotationSendMenuContent
              worktreeId={worktreeId}
              groupId={activeGroupId ?? worktreeId}
              prompt={browserAnnotationsPrompt}
              onPromptDelivered={handleBrowserAnnotationsSentToAgent}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="xs"
          variant="outline"
          className="gap-1.5"
          onClick={handleCopyBrowserAnnotations}
        >
          {browserAnnotationsCopied ? (
            <CircleCheck className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
          {browserAnnotationsCopied
            ? translate('auto.components.browser.pane.BrowserPane.6f4ab3592b', 'Copied')
            : translate('auto.components.browser.pane.BrowserPane.d51ef37351', 'Copy')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleClearBrowserAnnotations}
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.734e4343ec',
                'Clear browser annotations'
              )}
            >
              <Trash2 className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.browser.pane.BrowserPane.11c5084aa2', 'Clear annotations')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-1.5">
        {browserAnnotations.map((annotation, index) => {
          const isEditing = annotation.id === editingAnnotationId
          return (
            <div
              key={annotation.id}
              className="group flex gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent focus-within:bg-accent"
            >
              <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                {index + 1}
              </div>
              {isEditing ? (
                <div
                  className="min-w-0 flex-1"
                  data-slot="annotation-edit"
                  onKeyDown={(event) => {
                    // Why: bail-out selector in useGrabMode lets this reach any focused child, not just the textarea.
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      handleCancelEdit()
                    }
                  }}
                >
                  <textarea
                    value={editComment}
                    onChange={(event) => setEditComment(event.target.value)}
                    maxLength={GRAB_BUDGET.annotationCommentMaxLength}
                    className="h-16 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                    autoFocus
                    aria-label={translate(
                      'auto.components.browser.pane.BrowserPane.d2a7092e6e',
                      'Annotation comment'
                    )}
                    onKeyDown={(event) => {
                      if (isScreenSubmitShortcut(event)) {
                        event.preventDefault()
                        event.stopPropagation()
                        handleSaveEdit()
                      }
                    }}
                  />
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    value={editIntent}
                    onValueChange={(value) => {
                      if (value) {
                        setEditIntent(value as BrowserAnnotationIntent)
                      }
                    }}
                    className="mt-1.5 h-7 w-full [&_[data-slot=toggle-group-item]]:h-7 [&_[data-slot=toggle-group-item]]:flex-1 [&_[data-slot=toggle-group-item]]:px-1.5"
                    aria-label={translate(
                      'auto.components.browser.pane.annotate.browser.page.annotation.tray.449d2c2629',
                      'Annotation intent'
                    )}
                  >
                    {BROWSER_ANNOTATION_INTENT_OPTIONS.map((option) => {
                      const Icon = option.icon
                      return (
                        <ToggleGroupItem
                          key={option.value}
                          value={option.value}
                          aria-label={option.label}
                          className="gap-1 text-[11px] data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground"
                        >
                          <Icon className="size-3" />
                          <span>{option.label}</span>
                        </ToggleGroupItem>
                      )
                    })}
                  </ToggleGroup>
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <Button size="xs" variant="ghost" onClick={handleCancelEdit}>
                      {translate(
                        'auto.components.browser.pane.annotate.browser.page.annotation.tray.024467ceac',
                        'Cancel'
                      )}
                    </Button>
                    <Button size="xs" disabled={!editComment.trim()} onClick={handleSaveEdit}>
                      {translate(
                        'auto.components.browser.pane.annotate.browser.page.annotation.tray.c16f932cb3',
                        'Save'
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {annotation.payload.target.accessibility.accessibleName ||
                        annotation.payload.target.textSnippet ||
                        annotation.payload.target.tagName}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                      {annotation.comment}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      <span>{annotation.intent}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-start gap-0.5">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="can-hover:opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                      onClick={() => handleStartEdit(annotation)}
                      aria-label={translate(
                        'auto.components.browser.pane.annotate.browser.page.annotation.tray.09a7c1df70',
                        'Edit annotation {{value0}}',
                        { value0: index + 1 }
                      )}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="can-hover:opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                      onClick={() => handleDeleteBrowserAnnotation(annotation.id)}
                      aria-label={translate(
                        'auto.components.browser.pane.BrowserPane.f2d0c22d67',
                        'Delete annotation {{value0}}',
                        { value0: index + 1 }
                      )}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
