import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { useAppStore } from '@/store'
export function TaskPageBusinessmapFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    setTaskResumeState,
    businessmapPresets,
    businessmapLoading,
    businessmapSearchInput,
    setBusinessmapSearchInput,
    setAppliedBusinessmapSearch,
    activeBusinessmapPreset,
    setActiveBusinessmapPreset,
    setBusinessmapRefreshNonce,
    businessmapBoardsLoading,
    availableBusinessmapBoards,
    setNewBusinessmapCardOpen,
    setNewBusinessmapCardTitle,
    setNewBusinessmapCardBody,
    setNewBusinessmapCardBoardId
  } = model
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {businessmapPresets.map((preset) => {
            const active = !businessmapSearchInput && activeBusinessmapPreset === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setBusinessmapSearchInput('')
                  setAppliedBusinessmapSearch('')
                  setActiveBusinessmapPreset(preset.id)
                  setTaskResumeState({
                    businessmapPreset: preset.id,
                    businessmapQuery: ''
                  })
                  setBusinessmapRefreshNonce((n) => n + 1)
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
                  const draft = useAppStore.getState().newBusinessmapCardDraft
                  setNewBusinessmapCardTitle(draft?.title ?? '')
                  setNewBusinessmapCardBody(draft?.body ?? '')
                  setNewBusinessmapCardBoardId(availableBusinessmapBoards[0]?.id ?? null)
                  setNewBusinessmapCardOpen(true)
                }}
                disabled={availableBusinessmapBoards.length === 0 || businessmapBoardsLoading}
                aria-label={translate(
                  'auto.components.TaskPage.businessmapNewCard',
                  'New Businessmap card'
                )}
              >
                {businessmapBoardsLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.businessmapNewCard', 'New Businessmap card')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setBusinessmapRefreshNonce((n) => n + 1)}
                disabled={businessmapLoading}
                aria-label={translate(
                  'auto.components.TaskPage.businessmapRefresh',
                  'Refresh Businessmap cards'
                )}
              >
                {businessmapLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.TaskPage.businessmapRefresh',
                'Refresh Businessmap cards'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={businessmapSearchInput}
            onChange={(e) => setBusinessmapSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (
                  shouldSuppressEnterSubmit(
                    {
                      isComposing: e.nativeEvent.isComposing,
                      shiftKey: e.shiftKey
                    },
                    false
                  )
                ) {
                  return
                }
                e.preventDefault()
                const trimmed = businessmapSearchInput.trim()
                setBusinessmapSearchInput(trimmed)
                setAppliedBusinessmapSearch(trimmed)
                setTaskResumeState({
                  businessmapQuery: trimmed
                })
                setBusinessmapRefreshNonce((n) => n + 1)
              }
            }}
            placeholder={translate(
              'auto.components.TaskPage.businessmapSearchPlaceholder',
              'Search Businessmap cards'
            )}
            className="h-8"
          />
          {businessmapSearchInput ? (
            <button
              type="button"
              onClick={() => {
                setBusinessmapSearchInput('')
                setAppliedBusinessmapSearch('')
                setTaskResumeState({
                  businessmapQuery: ''
                })
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
