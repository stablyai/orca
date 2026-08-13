import { useLayoutEffect, useState } from 'react'
import { Check, ChevronDown, ListFilter, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { JiraSavedFilter } from '../../../shared/types'
import type { ActiveJiraFilterRef, JiraCustomFilter } from '../../../shared/jira-custom-filters'

export type JiraCustomFilterDraft = { name: string; jql: string }

type TaskPageJiraFilterMenuProps = {
  savedFilters: JiraSavedFilter[]
  savedFiltersLoading: boolean
  customFilters: JiraCustomFilter[]
  activeFilter: ActiveJiraFilterRef | null
  showSiteName: boolean
  /** Prefills the JQL field of a new custom filter (e.g. the current search). */
  initialJql?: string
  onSelectSaved: (filter: JiraSavedFilter) => void
  onSelectCustom: (filter: JiraCustomFilter) => void
  onCreateCustom: (draft: JiraCustomFilterDraft) => void
  onUpdateCustom: (id: string, draft: JiraCustomFilterDraft) => void
  onDeleteCustom: (id: string) => void
}

type FilterDialogState = { mode: 'create' } | { mode: 'edit'; filter: JiraCustomFilter }

function isActiveSaved(active: ActiveJiraFilterRef | null, filter: JiraSavedFilter): boolean {
  return (
    active?.source === 'saved' && active.siteId === filter.siteId && active.filterId === filter.id
  )
}

export function TaskPageJiraFilterMenu({
  savedFilters,
  savedFiltersLoading,
  customFilters,
  activeFilter,
  showSiteName,
  initialJql,
  onSelectSaved,
  onSelectCustom,
  onCreateCustom,
  onUpdateCustom,
  onDeleteCustom
}: TaskPageJiraFilterMenuProps): React.JSX.Element {
  const [dialogState, setDialogState] = useState<FilterDialogState | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftJql, setDraftJql] = useState('')

  // Reset the draft before paint on every open so a stale draft never flashes.
  useLayoutEffect(() => {
    if (!dialogState) {
      return
    }
    if (dialogState.mode === 'edit') {
      setDraftName(dialogState.filter.name)
      setDraftJql(dialogState.filter.jql)
    } else {
      setDraftName('')
      setDraftJql(initialJql ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogState])

  const activeCustomFilter =
    activeFilter?.source === 'custom'
      ? customFilters.find((filter) => filter.id === activeFilter.id)
      : undefined
  const activeLabel =
    activeFilter?.source === 'saved' ? activeFilter.name : activeCustomFilter?.name
  const canSaveDraft = draftName.trim().length > 0 && draftJql.trim().length > 0

  const submitDraft = (): void => {
    if (!canSaveDraft || !dialogState) {
      return
    }
    const draft = { name: draftName.trim(), jql: draftJql.trim() }
    if (dialogState.mode === 'edit') {
      onUpdateCustom(dialogState.filter.id, draft)
    } else {
      onCreateCustom(draft)
    }
    setDialogState(null)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex max-w-56 items-center gap-1 rounded-md border px-2 py-1 text-xs transition',
              activeLabel
                ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
            )}
          >
            <ListFilter className="size-3.5 shrink-0" />
            <span className="truncate">
              {activeLabel ?? translate('auto.components.TaskPage.jiraFiltersMenuLabel', 'Filters')}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-96 w-72 overflow-y-auto scrollbar-sleek"
        >
          <DropdownMenuLabel className="text-muted-foreground">
            {translate('auto.components.TaskPage.jiraFiltersSavedHeading', 'Saved in Jira')}
          </DropdownMenuLabel>
          {savedFilters.map((filter) => (
            <DropdownMenuItem
              key={`${filter.siteId}:${filter.id}`}
              onSelect={() => onSelectSaved(filter)}
            >
              <Check
                className={cn(
                  'size-3.5',
                  isActiveSaved(activeFilter, filter) ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{filter.name}</span>
              {showSiteName && filter.siteName ? (
                <span className="max-w-24 shrink-0 truncate text-[11px] text-muted-foreground">
                  {filter.siteName}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {savedFilters.length === 0 ? (
            <div className="px-2 py-1 text-[12px] text-muted-foreground">
              {savedFiltersLoading
                ? translate('auto.components.TaskPage.jiraFiltersLoadingSaved', 'Loading…')
                : translate('auto.components.TaskPage.jiraFiltersSavedEmpty', 'No saved filters')}
            </div>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground">
            {translate('auto.components.TaskPage.jiraFiltersCustomHeading', 'My filters')}
          </DropdownMenuLabel>
          {customFilters.map((filter) => {
            const active = activeFilter?.source === 'custom' && activeFilter.id === filter.id
            return (
              <DropdownMenuItem key={filter.id} onSelect={() => onSelectCustom(filter)}>
                <Check className={cn('size-3.5', active ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0 flex-1 truncate">{filter.name}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={translate(
                      'auto.components.TaskPage.jiraFiltersEditAria',
                      'Edit filter “{{name}}”',
                      { name: filter.name }
                    )}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDialogState({ mode: 'edit', filter })
                    }}
                    className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={translate(
                      'auto.components.TaskPage.jiraFiltersDeleteAria',
                      'Delete filter “{{name}}”',
                      { name: filter.name }
                    )}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteCustom(filter.id)
                    }}
                    className="rounded p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuItem onSelect={() => setDialogState({ mode: 'create' })}>
            <Plus className="size-3.5" />
            {translate('auto.components.TaskPage.jiraFiltersNewCustom', 'New custom filter…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogState !== null} onOpenChange={(open) => !open && setDialogState(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogState?.mode === 'edit'
                ? translate('auto.components.TaskPage.jiraFiltersDialogTitleEdit', 'Edit filter')
                : translate('auto.components.TaskPage.jiraFiltersDialogTitleNew', 'New filter')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.TaskPage.jiraFiltersDialogDescription',
                'Saved on this device. The JQL runs against your connected Jira sites.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jira-filter-name">
                {translate('auto.components.TaskPage.jiraFiltersNameLabel', 'Name')}
              </Label>
              <Input
                id="jira-filter-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder={translate(
                  'auto.components.TaskPage.jiraFiltersNamePlaceholder',
                  'e.g. My open bugs'
                )}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jira-filter-jql">
                {translate('auto.components.TaskPage.jiraFiltersJqlLabel', 'JQL')}
              </Label>
              <Input
                id="jira-filter-jql"
                value={draftJql}
                onChange={(event) => setDraftJql(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitDraft()
                  }
                }}
                placeholder={translate(
                  'auto.components.TaskPage.99c2755218',
                  'Jira JQL, e.g. project = ABC AND statusCategory != Done'
                )}
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogState(null)}>
              {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
            </Button>
            <Button onClick={submitDraft} disabled={!canSaveDraft}>
              {translate('auto.components.TaskPage.jiraFiltersSave', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
