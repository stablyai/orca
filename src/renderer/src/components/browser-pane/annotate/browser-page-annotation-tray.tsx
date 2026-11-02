import { ImeTextarea } from '@/lib/ime-text-field'
import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  Image as ImageIcon,
  Pencil,
  Send,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
import {
  BrowserAnnotationSendMenuContent,
  browserAnnotationCopyTooltip
} from './BrowserAnnotationSendMenuContent'
import { preventAgentSendTargetOutsideDismiss } from './prevent-agent-send-target-outside-dismiss'
import { browserAnnotationMatchesPageUrl } from './browser-annotation-page-url'
import { useBrowserAnnotationImages } from './use-browser-annotation-images'
import { BrowserAnnotationImageStrip } from './browser-annotation-image-strip'
import type { BrowserPageAnnotationTrayProps } from '../describe-page/browser-page-types'

export function BrowserPageAnnotationTray({
  browserAnnotations,
  currentUrl,
  annotationTraySendOpen,
  handleAnnotationTraySendOpenChange,
  worktreeId,
  activeGroupId,
  browserAnnotationsPrompt,
  includePageDetails,
  handleIncludePageDetailsChange,
  handleBrowserAnnotationsSentToAgent,
  handleBrowserAnnotationsHandedOff,
  handleCopyBrowserAnnotations,
  browserAnnotationsCopied,
  handleClearBrowserAnnotations,
  handleDeleteBrowserAnnotation,
  handleUpdateBrowserAnnotation
}: BrowserPageAnnotationTrayProps): React.JSX.Element {
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const [editComment, setEditComment] = useState('')
  const [editIntent, setEditIntent] = useState<BrowserAnnotationIntent>('change')
  const editImages = useBrowserAnnotationImages(worktreeId)
  const resetEditImages = editImages.resetImages
  const [expanded, setExpanded] = useState(true)
  const ToggleChevron = expanded ? ChevronDown : ChevronRight

  // Why: a delete or clear while a row is mid-edit must not leave edit state pointing at nothing.
  useEffect(() => {
    if (
      editingAnnotationId &&
      !browserAnnotations.some((annotation) => annotation.id === editingAnnotationId)
    ) {
      setEditingAnnotationId(null)
      resetEditImages()
    }
  }, [browserAnnotations, editingAnnotationId, resetEditImages])

  const handleStartEdit = (annotation: BrowserPageAnnotation): void => {
    setEditingAnnotationId(annotation.id)
    setEditComment(annotation.comment)
    setEditIntent(annotation.intent)
    editImages.resetImages(annotation.imagePaths)
  }

  const handleCancelEdit = (): void => {
    setEditingAnnotationId(null)
    editImages.resetImages()
  }

  const canSaveEdit = Boolean(editComment.trim()) && !editImages.saving
  const handleSaveEdit = (): void => {
    if (!canSaveEdit || !editingAnnotationId) {
      return
    }
    handleUpdateBrowserAnnotation(
      editingAnnotationId,
      editComment.trim(),
      editIntent,
      editImages.imagePaths
    )
    handleCancelEdit()
  }

  return (
    <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
      <div className="absolute right-3 bottom-3 z-30 flex max-h-[45%] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <ToggleChevron className="size-4 shrink-0 text-muted-foreground" />
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
                </button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {expanded
                ? translate(
                    'auto.components.browser.pane.annotate.browser.page.annotation.tray.38d320108c',
                    'Collapse annotations'
                  )
                : translate(
                    'auto.components.browser.pane.annotate.browser.page.annotation.tray.9f209891a7',
                    'Expand annotations'
                  )}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu
            modal={false}
            open={annotationTraySendOpen}
            onOpenChange={handleAnnotationTraySendOpenChange}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="xs"
                    variant="outline"
                    className="gap-1.5"
                    disabled={!browserAnnotationsPrompt}
                  >
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
                includePageDetails={includePageDetails}
                onIncludePageDetailsChange={handleIncludePageDetailsChange}
                onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                onPromptHandedOff={handleBrowserAnnotationsHandedOff}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {browserAnnotationCopyTooltip(includePageDetails)}
            </TooltipContent>
          </Tooltip>
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
              {translate(
                'auto.components.browser.pane.BrowserPane.11c5084aa2',
                'Clear annotations'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        {/* Why: stay mounted while collapsed so the list keeps its scroll position. */}
        <CollapsibleContent asChild forceMount>
          <div
            className="scrollbar-sleek min-h-0 flex-1 overflow-auto border-t border-border p-1.5"
            hidden={!expanded}
          >
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
                        // Why: useGrabMode's bail-out lets this reach any focused child; an image preview's portal only closes itself.
                        if (
                          event.key === 'Escape' &&
                          event.target instanceof Node &&
                          event.currentTarget.contains(event.target)
                        ) {
                          event.preventDefault()
                          event.stopPropagation()
                          handleCancelEdit()
                        }
                      }}
                    >
                      <ImeTextarea
                        value={editComment}
                        onChange={(event) => setEditComment(event.target.value)}
                        onPaste={editImages.handlePaste}
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
                      <BrowserAnnotationImageStrip
                        images={editImages.images}
                        onRemove={editImages.removeImage}
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
                        <Button size="xs" disabled={!canSaveEdit} onClick={handleSaveEdit}>
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
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{annotation.intent}</span>
                          {annotation.imagePaths?.length ? (
                            <span className="flex items-center gap-0.5">
                              <ImageIcon className="size-3" />
                              {annotation.imagePaths.length}
                            </span>
                          ) : null}
                          {currentUrl !== undefined &&
                          !browserAnnotationMatchesPageUrl(
                            annotation.payload.page.sanitizedUrl,
                            currentUrl
                          ) ? (
                            <span className="truncate" title={annotation.payload.page.sanitizedUrl}>
                              {annotation.payload.page.sanitizedUrl}
                            </span>
                          ) : null}
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
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
