import React from 'react'
import { List, ListTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings, SourceControlViewMode } from '../../../../shared/types'

type SourceControlViewModeEducationSettings = Pick<
  GlobalSettings,
  'sourceControlViewModeEducationDismissed'
>

export function shouldShowSourceControlViewModeEducation(
  settings: SourceControlViewModeEducationSettings | null | undefined
): boolean {
  return settings?.sourceControlViewModeEducationDismissed === false
}

export function createSourceControlViewModeEducationChoiceUpdate(
  mode: SourceControlViewMode
): Pick<GlobalSettings, 'sourceControlViewMode' | 'sourceControlViewModeEducationDismissed'> {
  return {
    sourceControlViewMode: mode,
    sourceControlViewModeEducationDismissed: true
  }
}

export function createSourceControlViewModeEducationDismissUpdate(): Pick<
  GlobalSettings,
  'sourceControlViewModeEducationDismissed'
> {
  return { sourceControlViewModeEducationDismissed: true }
}

export function SourceControlViewModeEducation({
  sourceControlViewMode,
  disabled,
  onChooseViewMode,
  onDismiss
}: {
  sourceControlViewMode: SourceControlViewMode
  disabled: boolean
  onChooseViewMode: (mode: SourceControlViewMode) => void
  onDismiss: () => void
}): React.JSX.Element {
  const viewOptionsLabel = translate(
    'auto.components.right.sidebar.SourceControl.7b26e5a8c1',
    'View options'
  )
  const treeLabel = translate('auto.components.right.sidebar.SourceControl.e7a9f63a12', 'Tree')
  const listLabel = translate('auto.components.right.sidebar.SourceControl.f3b91c50a4', 'List')
  const dismissLabel = translate(
    'auto.components.right.sidebar.SourceControl.ccd4a812af',
    'Dismiss view options'
  )

  return (
    <div className="border-b border-border px-3 py-2">
      <section
        role="region"
        aria-label={viewOptionsLabel}
        className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground shadow-xs"
      >
        <div className="h-0.5 bg-foreground/15" aria-hidden="true" />
        <div className="px-2.5 py-2.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-xs leading-4 font-medium text-muted-foreground">
                {viewOptionsLabel}
              </p>
              <p className="text-xs leading-4 font-semibold text-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControl.96fd0e13a7',
                  'Choose how Source Control groups files'
                )}
              </p>
              <p className="text-xs leading-4 text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControl.d4e8a6f312',
                  'Use folders for structure or one flat list for scanning. Change this later from More actions.'
                )}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={disabled}
                  onClick={onDismiss}
                  aria-label={dismissLabel}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {dismissLabel}
              </TooltipContent>
            </Tooltip>
          </div>
          <ToggleGroup
            type="single"
            value={sourceControlViewMode}
            disabled={disabled}
            variant="outline"
            size="sm"
            className="mt-2 h-7 w-full rounded-md border border-border bg-muted/35 shadow-xs"
            aria-label={viewOptionsLabel}
          >
            <ToggleGroupItem
              value="tree"
              className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs"
              onClick={() => onChooseViewMode('tree')}
              aria-label={translate(
                'auto.components.right.sidebar.SourceControl.19d52c8a04',
                'Use tree view'
              )}
            >
              <ListTree className="size-3.5" aria-hidden="true" />
              {treeLabel}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="list"
              className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs"
              onClick={() => onChooseViewMode('list')}
              aria-label={translate(
                'auto.components.right.sidebar.SourceControl.0f2a91c7b5',
                'Use list view'
              )}
            >
              <List className="size-3.5" aria-hidden="true" />
              {listLabel}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </section>
    </div>
  )
}
