import { useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref } from 'react'
import { CircleStop, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getAddRepoLocalStartActions } from './add-repo-local-start-actions'
import { translate } from '@/i18n/i18n'

type AddRepoNestedScanProgressNoticeProps = {
  busyLabel: string
  nestedScanInProgress: boolean
  nestedScanId: string | null
  onStopNestedScan: () => void
}

function AddRepoNestedScanProgressNotice({
  busyLabel,
  nestedScanInProgress,
  nestedScanId,
  onStopNestedScan
}: AddRepoNestedScanProgressNoticeProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">{busyLabel}</span>
      {nestedScanInProgress && nestedScanId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
              aria-label={translate(
                'auto.components.sidebar.AddRepoStartSteps.9906cae183',
                'Stop scan'
              )}
              title={translate(
                'auto.components.sidebar.AddRepoStartSteps.69ea7f8dc4',
                'Stop scanning'
              )}
              onClick={onStopNestedScan}
            >
              <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
              <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.sidebar.AddRepoStartSteps.d301db1c9a',
              'Scanning repositories. Click to stop.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

type AddRepoLocalStartStepProps = {
  repoCount: number
  isAdding: boolean
  addProjectBusyLabel: string | null
  nestedScanInProgress: boolean
  nestedScanId: string | null
  hostSelector?: ReactNode
  notice?: ReactNode
  actionsDisabled?: boolean
  browseHostKind?: 'local' | 'runtime'
  offersServerSshHosts?: boolean
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenRemoteStep: () => void
  onOpenCreateStep: () => void
  onStopNestedScan: () => void
}

export function AddRepoLocalStartStep({
  repoCount,
  isAdding,
  addProjectBusyLabel,
  nestedScanInProgress,
  nestedScanId,
  hostSelector,
  notice,
  actionsDisabled = false,
  browseHostKind = 'local',
  offersServerSshHosts,
  onBrowse,
  onOpenCloneStep,
  onOpenRemoteStep,
  onOpenCreateStep,
  onStopNestedScan
}: AddRepoLocalStartStepProps): React.JSX.Element {
  const browseActionRef = useRef<HTMLButtonElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const actionsUnavailable = isAdding || actionsDisabled
  const { primaryAction, secondaryActions } = getAddRepoLocalStartActions({
    onBrowse,
    onOpenCloneStep,
    onOpenRemoteStep,
    onOpenCreateStep,
    browseHostKind,
    offersServerSshHosts
  })

  // The highlight and Enter chip follow keyboard focus; Browse is only the initial selection.
  const [selectedKind, setSelectedKind] = useState<string | null>(primaryAction.kind)
  const visibleSelectedKind = actionsUnavailable ? null : selectedKind

  useEffect(() => {
    if (!actionsUnavailable) {
      browseActionRef.current?.focus()
    }
  }, [actionsUnavailable])

  const handleArrowNavigation = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }
    const buttons = Array.from(
      actionsRef.current?.querySelectorAll<HTMLButtonElement>('button[data-add-repo-action]') ?? []
    )
    if (buttons.length === 0) {
      return
    }
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length
    event.preventDefault()
    buttons[nextIndex]?.focus()
  }

  const handleActionsBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof HTMLButtonElement)) {
      setSelectedKind(null)
      return
    }
    if (!event.relatedTarget.matches('button[data-add-repo-action]')) {
      setSelectedKind(null)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.sidebar.AddRepoStartSteps.d13757911c', 'Add a project')}
        </DialogTitle>
        {repoCount === 0 ? (
          <DialogDescription>
            {translate(
              'auto.components.sidebar.AddRepoStartSteps.acf895cb42',
              'Add a project to get started with Orca.'
            )}
          </DialogDescription>
        ) : null}
      </DialogHeader>

      <div
        className="space-y-3 pt-2"
        ref={actionsRef}
        onBlur={handleActionsBlur}
        onKeyDown={handleArrowNavigation}
      >
        {hostSelector}
        {notice}
        <AddRepoPrimaryStartAction
          icon={primaryAction.icon}
          title={primaryAction.title}
          description={primaryAction.description}
          disabled={actionsUnavailable}
          selected={visibleSelectedKind === primaryAction.kind}
          buttonRef={browseActionRef}
          onClick={primaryAction.onClick}
          onFocus={() => setSelectedKind(primaryAction.kind)}
        />
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.sidebar.AddRepoStartSteps.87596c1446', 'Other ways to add')}
          </p>
          {/* Use input for the outline; primary-foreground is near-black and disappears in dark mode. */}
          <div className="overflow-hidden rounded-md border border-input bg-background">
            {secondaryActions.map((action, index) => (
              <AddRepoSecondaryStartAction
                key={action.kind}
                icon={action.icon}
                title={action.title}
                description={action.description}
                disabled={actionsUnavailable || Boolean(action.disabled)}
                selected={visibleSelectedKind === action.kind}
                onClick={action.onClick}
                onFocus={() => setSelectedKind(action.kind)}
                className={cn(
                  index === 0 ? 'rounded-t-md' : 'border-t border-border/70',
                  index === secondaryActions.length - 1 && 'rounded-b-md'
                )}
              />
            ))}
          </div>
        </div>

        {isAdding && addProjectBusyLabel ? (
          <AddRepoNestedScanProgressNotice
            busyLabel={addProjectBusyLabel}
            nestedScanInProgress={nestedScanInProgress}
            nestedScanId={nestedScanId}
            onStopNestedScan={onStopNestedScan}
          />
        ) : null}
      </div>
    </>
  )
}

type AddRepoStartActionProps = {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  disabled: boolean
  selected: boolean
  onClick: () => void
  onFocus: () => void
  buttonRef?: Ref<HTMLButtonElement>
}

const AddRepoEnterChip = (): React.JSX.Element => (
  <span aria-hidden="true" className="shrink-0">
    <ShortcutKeyCombo
      keys={['⏎']}
      keyCapClassName="border-border/80 bg-background/70 text-muted-foreground"
    />
  </span>
)

const AddRepoPrimaryStartAction = ({
  icon: Icon,
  title,
  description,
  disabled,
  selected,
  onClick,
  onFocus,
  buttonRef
}: AddRepoStartActionProps): React.JSX.Element => (
  <Button
    ref={buttonRef}
    type="button"
    variant="ghost"
    onClick={onClick}
    onFocus={onFocus}
    disabled={disabled}
    data-add-repo-action
    className={cn(
      'h-auto min-h-[3.75rem] w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-left',
      selected
        ? 'border border-ring bg-foreground/10 text-foreground focus-visible:border-ring focus-visible:ring-0 dark:bg-accent dark:text-accent-foreground'
        : 'border border-border bg-background shadow-none dark:bg-background'
    )}
  >
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md',
        selected ? 'bg-background/70 text-accent-foreground' : 'text-foreground'
      )}
    >
      <Icon className="size-4" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium leading-5">{title}</span>
      <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">
        {description}
      </span>
    </span>
    {selected ? <AddRepoEnterChip /> : null}
  </Button>
)

function AddRepoSecondaryStartAction({
  icon: Icon,
  title,
  description,
  disabled,
  selected,
  onClick,
  onFocus,
  className
}: AddRepoStartActionProps & { className?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      data-add-repo-action
      disabled={disabled}
      onClick={onClick}
      onFocus={onFocus}
      className={cn(
        'flex min-h-[3.25rem] w-full items-center gap-3 border border-transparent px-3 py-2.5 text-left transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:cursor-default disabled:opacity-40',
        className,
        selected
          ? 'border-ring bg-foreground/10 text-foreground focus-visible:ring-0 dark:bg-accent dark:text-accent-foreground'
          : 'hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50'
      )}
    >
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md',
          selected ? 'bg-background/70 text-accent-foreground' : 'text-muted-foreground'
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-sm font-medium leading-5',
            selected ? 'text-accent-foreground' : 'text-foreground'
          )}
        >
          {title}
        </span>
        <span className="block text-xs leading-4 text-muted-foreground">{description}</span>
      </span>
      {selected ? <AddRepoEnterChip /> : null}
    </button>
  )
}
