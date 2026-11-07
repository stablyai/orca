import { isUtf8ByteLengthWithinLimit } from '../../../../../shared/utf8-byte-limits'
import { useState } from 'react'
import { Check, ListFilter, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  MAX_JIRA_SAVED_FILTERS,
  type JiraSavedFilter
} from '../../../../../shared/jira/jira-saved-filters'
import { translate } from '@/i18n/i18n'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty
} from '@/components/ui/command'
import { Textarea } from '@/components/ui/textarea'
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
  disabled?: boolean
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onApply: (filter: JiraSavedFilter) => Promise<void>
  onCreate: (filter: { name: string; jql: string }) => Promise<void>
  onUpdate: (id: string, filter: { name: string; jql: string }) => Promise<void>
  onDelete: (id: string) => Promise<void>
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
  onDelete,
  disabled = false,
  loading = false,
  error,
  onRetry
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
    isUtf8ByteLengthWithinLimit(draft.jql, MAX_JIRA_SAVED_FILTER_JQL_LENGTH) &&
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

  const saveDraft = async (): Promise<void> => {
    if (!draft || !canSubmit) {
      return
    }
    const value = { name: draft.name.trim(), jql: draft.jql.trim() }
    await (draft.mode === 'edit' && draft.id ? onUpdate(draft.id, value) : onCreate(value))
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
        <PopoverContent align="start" sideOffset={6} className="w-72">
          <div className="border-b border-border/50 px-3 py-2">
            <p className="text-xs font-medium">
              {translate('auto.components.TaskPageJiraSavedFilters.6c381858a1', 'Saved filters')}
            </p>
          </div>
          {error ? (
            <div className="space-y-2 p-3">
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
              <Button size="xs" variant="outline" onClick={onRetry}>
                {translate('jira.savedFilters.retry', 'Retry')}
              </Button>
            </div>
          ) : null}
          <Command>
            <CommandInput
              placeholder={translate('jira.savedFilters.find', 'Find a saved filter')}
            />
            <CommandList className="max-h-72">
              {filters.length > 0 ? (
                <CommandEmpty>
                  {translate('jira.savedFilters.noMatch', 'No matching filters.')}
                </CommandEmpty>
              ) : null}
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
                    <CommandItem
                      key={filter.id}
                      value={filter.name}
                      disabled={disabled}
                      className="group"
                      onSelect={() => {
                        setPopoverOpen(false)
                        void onApply(filter).catch(() => {})
                      }}
                    >
                      <div
                        aria-current={active ? 'true' : undefined}
                        data-current={active ? 'true' : undefined}
                        className="flex min-w-0 flex-1 items-center gap-2 text-xs"
                      >
                        <Check
                          aria-hidden
                          className={active ? 'size-3.5 shrink-0' : 'size-3.5 shrink-0 opacity-0'}
                        />
                        <span className="truncate">{filter.name}</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={translate(
                          'auto.components.TaskPageJiraSavedFilters.af0dd8c528',
                          'Edit {{value0}}',
                          { value0: filter.name }
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEditDialog(filter)
                        }}
                        disabled={disabled}
                      >
                        <Pencil />
                      </Button>
                    </CommandItem>
                  )
                })
              )}
            </CommandList>
          </Command>
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
              className="w-full justify-start"
              disabled={disabled || loading || !currentJql.trim() || filterLimitReached}
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
            <DialogTitle>
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
            <DialogDescription>
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
              void saveDraft().catch(() => {})
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
              <Textarea
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
                variant="code"
              />
            </div>

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter className={draft?.mode === 'edit' ? 'sm:justify-between' : undefined}>
              {draft?.mode === 'edit' ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    if (draft.id) {
                      void onDelete(draft.id)
                        .then(() => setDraft(null))
                        .catch(() => {})
                    }
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
                <Button type="submit" size="sm" disabled={disabled || !canSubmit}>
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
