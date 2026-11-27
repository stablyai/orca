import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { ChevronDown, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { getItsaplanStateTypeOptions } from '../task-page-localized-options'
import type { ItsaplanAssigneeFilter } from './use-task-page-itsaplan-list-state'

const ANYONE = 'anyone'

function assigneeFilterValue(assignee: ItsaplanAssigneeFilter): string {
  if (!assignee) {
    return ANYONE
  }
  return typeof assignee === 'object' ? `user:${assignee.userId}` : assignee
}

function parseAssigneeFilterValue(value: string): ItsaplanAssigneeFilter {
  if (value === 'me' || value === 'unassigned') {
    return value
  }
  return value.startsWith('user:') ? { userId: value.slice('user:'.length) } : undefined
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

const triggerClassName =
  'h-8 gap-1 rounded-md border-border/50 bg-background px-2.5 text-xs font-normal shadow-none'

export function TaskPageItsaplanFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    itsaplanMetadata,
    itsaplanStateTypes,
    setItsaplanStateTypes,
    itsaplanAssignee,
    setItsaplanAssignee,
    itsaplanLabelIds,
    setItsaplanLabelIds,
    itsaplanSearchInput,
    setItsaplanSearchInput,
    setAppliedItsaplanSearch,
    itsaplanLoading,
    refreshItsaplan
  } = model
  const stateOptions = getItsaplanStateTypeOptions()
  const members = itsaplanMetadata?.members ?? []
  const labels = itsaplanMetadata?.labels ?? []
  const stateLabel =
    itsaplanStateTypes.length === 0 || itsaplanStateTypes.length === stateOptions.length
      ? t('taskProviders.itsaplan.allStates', 'All states')
      : stateOptions
          .filter((option) => itsaplanStateTypes.includes(option.id))
          .map((option) => option.label)
          .join(', ')
  const selectedMember =
    typeof itsaplanAssignee === 'object'
      ? members.find((member) => member.userId === itsaplanAssignee.userId)
      : null
  const assigneeLabel =
    itsaplanAssignee === 'me'
      ? t('auto.components.TaskPage.94f0339621', 'Assigned to me')
      : itsaplanAssignee === 'unassigned'
        ? t('auto.components.TaskPage.42a9160321', 'Unassigned')
        : itsaplanAssignee
          ? (selectedMember?.name ?? t('auto.components.TaskPage.d2a876ca53', 'Assignee'))
          : t('auto.components.TaskPage.gitlabInvolvementEveryone', 'Everyone')
  const labelsLabel =
    itsaplanLabelIds.length === 0
      ? t('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
      : t('taskProviders.itsaplan.labelCount', '{{count}} labels', {
          count: itsaplanLabelIds.length,
          defaultValue_one: '{{count}} label'
        })
  const applySearch = (value: string): void => {
    setItsaplanSearchInput(value)
    setAppliedItsaplanSearch(value.trim())
  }
  return (
    <div className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 py-2 shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className={triggerClassName}>
              <span className="max-w-[180px] truncate">{stateLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>
              {t('auto.components.TaskPage.154b0fa623', 'Status')}
            </DropdownMenuLabel>
            {stateOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={itsaplanStateTypes.includes(option.id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() =>
                  setItsaplanStateTypes((current) => toggle(current, option.id))
                }
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className={triggerClassName}>
              <span className="max-w-[160px] truncate">{assigneeLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto scrollbar-sleek">
            <DropdownMenuRadioGroup
              value={assigneeFilterValue(itsaplanAssignee)}
              onValueChange={(value) => setItsaplanAssignee(parseAssigneeFilterValue(value))}
            >
              <DropdownMenuRadioItem value="me">
                {t('auto.components.TaskPage.94f0339621', 'Assigned to me')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unassigned">
                {t('auto.components.TaskPage.42a9160321', 'Unassigned')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value={ANYONE}>
                {t('auto.components.TaskPage.gitlabInvolvementEveryone', 'Everyone')}
              </DropdownMenuRadioItem>
              {members.length > 0 ? <DropdownMenuSeparator /> : null}
              {members.map((member) => (
                <DropdownMenuRadioItem key={member.userId} value={`user:${member.userId}`}>
                  <span className="truncate">{member.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={triggerClassName}
              disabled={labels.length === 0}
            >
              <span className="max-w-[140px] truncate">{labelsLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto scrollbar-sleek">
            {labels.map((label) => (
              <DropdownMenuCheckboxItem
                key={label.id}
                checked={itsaplanLabelIds.includes(label.id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => setItsaplanLabelIds((current) => toggle(current, label.id))}
              >
                <span className="truncate">{label.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={itsaplanSearchInput}
            onChange={(event) => setItsaplanSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                shouldSuppressEnterSubmit(
                  { isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey },
                  false
                )
              ) {
                return
              }
              event.preventDefault()
              applySearch(itsaplanSearchInput.trim())
            }}
            placeholder={t('taskProviders.itsaplan.searchPlaceholder', 'Search issues...')}
            className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
          />
          {itsaplanSearchInput ? (
            <button
              type="button"
              aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
              onClick={() => applySearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshItsaplan}
              disabled={itsaplanLoading}
              aria-label={t('taskProviders.itsaplan.refresh', 'Refresh')}
              className="size-8 border-border/50 bg-transparent hover:bg-muted/50"
            >
              {itsaplanLoading ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('taskProviders.itsaplan.refresh', 'Refresh')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
