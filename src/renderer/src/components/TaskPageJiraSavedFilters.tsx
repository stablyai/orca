import { useState } from 'react'
import { Check, ListFilter, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  MAX_JIRA_SAVED_FILTERS,
  type JiraSavedFilter
} from '../../../shared/jira-saved-filters'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type SavedFilterDraft = {
  mode: 'create' | 'edit'
  id: string | null
  name: string
  jql: string
}

type TaskPageJiraSavedFiltersProps = {
  filters: readonly JiraSavedFilter[]
  activeFilterId: string | null
  currentJql: string
  onApply: (filter: JiraSavedFilter) => void
  onCreate: (filter: { name: string; jql: string }) => void
  onUpdate: (id: string, filter: { name: string; jql: string }) => void
  onDelete: (id: string) => void
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

export function TaskPageJiraSavedFilters({
  filters,
  activeFilterId,
  currentJql,
  onApply,
  onCreate,
  onUpdate,
  onDelete
}: TaskPageJiraSavedFiltersProps): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [draft, setDraft] = useState<SavedFilterDraft | null>(null)
  const filterLimitReached = filters.length >= MAX_JIRA_SAVED_FILTERS
  const duplicateName = draft
    ? filters.some(
        (filter) =>
          filter.id !== draft.id && normalizedName(filter.name) === normalizedName(draft.name)
      )
    : false
  const canSubmit = Boolean(
    draft?.name.trim() &&
    draft.name.length <= MAX_JIRA_SAVED_FILTER_NAME_LENGTH &&
    draft.jql.trim() &&
    draft.jql.length <= MAX_JIRA_SAVED_FILTER_JQL_LENGTH &&
    !duplicateName
  )

  const openCreateDialog = (): void => {
    setPopoverOpen(false)
    setDraft({ mode: 'create', id: null, name: '', jql: currentJql.trim() })
  }

  const openEditDialog = (filter: JiraSavedFilter): void => {
    setPopoverOpen(false)
    setDraft({
      mode: 'edit',
      id: filter.id,
      name: filter.name,
      jql: filter.id === activeFilterId ? currentJql.trim() : filter.jql
    })
  }

  const saveDraft = (): void => {
    if (!draft || !canSubmit) {
      return
    }
    const value = { name: draft.name.trim(), jql: draft.jql.trim() }
    if (draft.mode === 'edit' && draft.id) {
      onUpdate(draft.id, value)
    } else {
      onCreate(value)
    }
    setDraft(null)
  }

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="xs">
            <ListFilter />
            {translate('auto.components.TaskPageJiraSavedFilters.6c381858a1', 'Saved filters')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-72 p-0">
          <div className="border-b border-border/50 px-3 py-2">
            <p className="text-xs font-medium">
              {translate('auto.components.TaskPageJiraSavedFilters.6c381858a1', 'Saved filters')}
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto p-1 scrollbar-sleek">
            {filters.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPageJiraSavedFilters.d14121662d',
                  'No saved filters yet.'
                )}
              </p>
            ) : (
              filters.map((filter) => {
                const active = filter.id === activeFilterId
                return (
                  <div key={filter.id} className="group flex items-center gap-1 rounded-md">
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      data-current={active ? 'true' : undefined}
                      onClick={() => {
                        setPopoverOpen(false)
                        onApply(filter)
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'bg-accent text-accent-foreground'
                      )}
                    >
                      <Check
                        aria-hidden
                        className={active ? 'size-3.5 shrink-0' : 'size-3.5 shrink-0 opacity-0'}
                      />
                      <span className="truncate">{filter.name}</span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate(
                        'auto.components.TaskPageJiraSavedFilters.af0dd8c528',
                        'Edit {{value0}}',
                        { value0: filter.name }
                      )}
                      onClick={() => openEditDialog(filter)}
                      className="text-muted-foreground can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Pencil />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
          <div className="border-t border-border/50 p-1">
            {filterLimitReached ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.TaskPageJiraSavedFilters.bae9bd87bf',
                  'You can save up to {{value0}} filters.',
                  { value0: MAX_JIRA_SAVED_FILTERS }
                )}
              </p>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              disabled={!currentJql.trim() || filterLimitReached}
              onClick={openCreateDialog}
            >
              <Plus />
              {translate(
                'auto.components.TaskPageJiraSavedFilters.85506127a5',
                'Save current filter'
              )}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {draft?.mode === 'edit'
                ? translate(
                    'auto.components.TaskPageJiraSavedFilters.7aef259c28',
                    'Edit Jira filter'
                  )
                : translate(
                    'auto.components.TaskPageJiraSavedFilters.4f0e55d2e5',
                    'Save Jira filter'
                  )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.TaskPageJiraSavedFilters.466c1b12ce',
                'Give this JQL query a name for quick access.'
              )}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              saveDraft()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="jira-saved-filter-name">
                {translate('auto.components.TaskPageJiraSavedFilters.e4c2f52972', 'Name')}
              </Label>
              <Input
                id="jira-saved-filter-name"
                autoFocus
                required
                maxLength={MAX_JIRA_SAVED_FILTER_NAME_LENGTH}
                value={draft?.name ?? ''}
                aria-invalid={duplicateName || undefined}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, name: event.target.value } : current
                  )
                }
              />
              {duplicateName ? (
                <p role="alert" className="text-xs text-destructive">
                  {translate(
                    'auto.components.TaskPageJiraSavedFilters.0ab71bb840',
                    'A saved filter with this name already exists.'
                  )}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="jira-saved-filter-jql">
                {translate('auto.components.TaskPageJiraSavedFilters.42ce360813', 'JQL')}
              </Label>
              <textarea
                id="jira-saved-filter-jql"
                required
                rows={5}
                maxLength={MAX_JIRA_SAVED_FILTER_JQL_LENGTH}
                value={draft?.jql ?? ''}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, jql: event.target.value } : current
                  )
                }
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>

            <DialogFooter className={draft?.mode === 'edit' ? 'sm:justify-between' : undefined}>
              {draft?.mode === 'edit' ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (draft.id) {
                      onDelete(draft.id)
                    }
                    setDraft(null)
                  }}
                >
                  <Trash2 />
                  {translate(
                    'auto.components.TaskPageJiraSavedFilters.7b21c59a26',
                    'Delete filter'
                  )}
                </Button>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  {translate('auto.components.TaskPageJiraSavedFilters.a62f9db53d', 'Cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit}>
                  {draft?.mode === 'edit'
                    ? translate(
                        'auto.components.TaskPageJiraSavedFilters.c77189bc0c',
                        'Update filter'
                      )
                    : translate(
                        'auto.components.TaskPageJiraSavedFilters.19af906d12',
                        'Save filter'
                      )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
