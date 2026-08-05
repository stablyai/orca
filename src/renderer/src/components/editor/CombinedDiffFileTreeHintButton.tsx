import React from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { hasFeatureInteraction } from '../../../../shared/feature-interactions'
import {
  applyCombinedDiffFileTreeHintChoice,
  type CombinedDiffFileTreeHintChoice
} from './combined-diff-file-tree-hint-choice'
import { shouldShowCombinedDiffFileTreeHint } from './combined-diff-file-tree-hint-visibility'
import { useCombinedDiffFileTreeHint } from './use-combined-diff-file-tree-hint'

export type CombinedDiffFileTreeHintButtonProps = {
  /** Each diff surface keeps its own translation key for the same "Show file tree" label. */
  label: string
  /**
   * Whether this viewer is on the visible workspace surface. Required (no default)
   * so a mounted-but-hidden pane can never force-open a portaled layer.
   */
  surfaceActive: boolean
  fileTreeCollapsed: boolean
  sectionsLoaded: boolean
  changedFileCount: number
  onSetFileTreeCollapsed: (collapsed: boolean) => void
}

// "Show file tree" toolbar button plus the one-shot discovery callout that asks, in
// place, what the default should be.
export function CombinedDiffFileTreeHintButton({
  label,
  surfaceActive,
  fileTreeCollapsed,
  sectionsLoaded,
  changedFileCount,
  onSetFileTreeCollapsed
}: CombinedDiffFileTreeHintButtonProps): React.JSX.Element {
  const defaultLabel = translate(
    'auto.components.editor.CombinedDiffFileTreeHintButton.4c1f0a7d92',
    'Default in diff views'
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const visibleByDefault = useAppStore(
    (s) => s.settings?.combinedDiffFileTreeVisibleByDefault === true
  )
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const hintDismissed = useAppStore((s) => s.combinedDiffFileTreeHintDismissed)
  // Why a boolean and not the map: recordFeatureInteraction rebuilds featureInteractions on
  // every call, and this viewer holds thousands of diff lines.
  const fileTreeAlreadyUsed = useAppStore((s) =>
    hasFeatureInteraction(s.featureInteractions, 'diff-file-tree')
  )
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const contextualToursOnboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const contextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.contextualToursBlockingSurfaceVisible
  )
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()
  const descriptionId = React.useId()

  const { hintOpen, dismissHint } = useCombinedDiffFileTreeHint({
    eligible: shouldShowCombinedDiffFileTreeHint({
      persistedUIReady,
      combinedDiffFileTreeHintDismissed: hintDismissed,
      surfaceActive,
      fileTreeCollapsed,
      sectionsLoaded,
      changedFileCount,
      combinedDiffFileTreeVisibleByDefault: visibleByDefault,
      fileTreeAlreadyUsed,
      activeContextualTourId,
      contextualToursOnboardingVisible,
      contextualToursBlockingSurfaceVisible
    }),
    surfaceActive
  })

  if (hintOpen && tooltipOpen) {
    // Why: Radix stops re-firing onOpenChange(false) once `open` is pinned false, so a hover
    // landed during the callout would leave this true and pop the tooltip on dismiss.
    setTooltipOpen(false)
  }

  const showFileTree = (): void => {
    dismissHint()
    onSetFileTreeCollapsed(false)
  }

  const chooseDefault = (choice: CombinedDiffFileTreeHintChoice): void => {
    applyCombinedDiffFileTreeHintChoice({
      choice,
      updateSettings,
      setFileTreeCollapsed: onSetFileTreeCollapsed,
      dismissHint
    })
  }

  const focusCallout = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    // Why Tab-into instead of autofocus: the callout is uninvited, so ripping focus out of a
    // diff mid-read is hostile; the trigger keeps focus and Tab is the announced way in
    // (aria-describedby names the callout, and Esc still closes it from anywhere).
    if (!hintOpen || event.key !== 'Tab' || event.shiftKey) {
      return
    }
    const target = contentRef.current?.querySelector<HTMLElement>('[role="radio"], button')
    if (!target) {
      return
    }
    event.preventDefault()
    target.focus()
  }

  // Why: Popover wrapping Tooltip keeps one persistent tree, so the trigger button is
  // not unmounted at the exact moment the hint points at it.
  return (
    <Popover
      modal={false}
      open={hintOpen}
      onOpenChange={(open) => {
        if (!open) {
          dismissHint()
        }
      }}
    >
      {/* Why forced closed while the hint is open: hovering the highlighted trigger would
          otherwise stack the tooltip on top of the callout explaining the same button.
          Kept controlled for its whole life so Radix never warns about the switch. */}
      <Tooltip open={hintOpen ? false : tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              aria-describedby={hintOpen ? descriptionId : undefined}
              className={cn(hintOpen && 'ring-2 ring-ring/45 ring-offset-1 ring-offset-background')}
              onClick={showFileTree}
              onKeyDown={focusCallout}
            >
              <PanelLeftOpen className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-80 p-3.5"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <div id={titleId} className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.CombinedDiffFileTreeHintButton.8b3e6c1af0',
            'Browse changes as a file tree'
          )}
        </div>
        <p id={descriptionId} className="mt-1 text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.editor.CombinedDiffFileTreeHintButton.d05a92be74',
            'See every changed file at once and jump between them without scrolling.'
          )}
        </p>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2.5">
          <div className="text-xs font-medium text-foreground">{defaultLabel}</div>
          <div className="mt-2">
            <SettingsSegmentedControl
              size="sm"
              equalWidth
              ariaLabel={defaultLabel}
              value={visibleByDefault ? 'shown' : 'hidden'}
              onChange={chooseDefault}
              options={[
                {
                  value: 'shown',
                  label: translate(
                    'auto.components.editor.CombinedDiffFileTreeHintButton.1e7c40b3d6',
                    'Shown'
                  )
                },
                {
                  value: 'hidden',
                  label: translate(
                    'auto.components.editor.CombinedDiffFileTreeHintButton.6f2a83c5e1',
                    'Hidden'
                  )
                }
              ]}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={dismissHint}
          >
            {translate(
              'auto.components.editor.CombinedDiffFileTreeHintButton.a91d0f7b23',
              'Dismiss'
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
