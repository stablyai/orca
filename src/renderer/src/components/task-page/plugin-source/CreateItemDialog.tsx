import { useEffect, useId, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  PluginTaskCreate,
  PluginTaskItem,
  PluginTaskItemType,
  PluginTaskScope,
  PluginTaskSourceResult
} from '../../../../../shared/plugins/plugin-task-source-contract'

/** The create verbs a source declared through `status().supports.create`.
 *  Absent — not disabled — when it declared none. */
export type PluginTaskSourceCreateControl = {
  listItemTypes: (scopeId: string) => Promise<PluginTaskSourceResult<PluginTaskItemType[]>>
  createItem: (input: PluginTaskCreate) => Promise<PluginTaskSourceResult<PluginTaskItem>>
  /** Re-reads the list so the new item arrives shaped like every other row and
   *  honours the active filter and scope. */
  onCreated: () => void
}

function createLabel(): string {
  return translate('auto.components.TaskPage.pluginTaskSourceCreate', 'New task')
}

/** Only when the user has narrowed to exactly one project: a work item opened
 *  in the wrong one is tedious to clean up, so "all" and "several" must ask. */
function unambiguousScopeId(selectedScopeIds: readonly string[]): string {
  return selectedScopeIds.length === 1 ? (selectedScopeIds[0] ?? '') : ''
}

function CreateItemForm({
  scopes,
  defaultScopeId,
  listItemTypes,
  createItem,
  onCreated,
  onClose
}: PluginTaskSourceCreateControl & {
  scopes: PluginTaskScope[]
  defaultScopeId: string
  onClose: () => void
}): React.JSX.Element {
  const fieldId = useId()
  const [scopeId, setScopeId] = useState(defaultScopeId)
  const [typeId, setTypeId] = useState('')
  const [types, setTypes] = useState<PluginTaskItemType[]>([])
  const [typesLoading, setTypesLoading] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (scopeId === '') {
      setTypes([])
      setTypeId('')
      return undefined
    }
    // Cleared before the call, not after it: the previous project's types must
    // never be pickable for the project now selected.
    setTypes([])
    setTypeId('')
    setTypesLoading(true)
    let current = true
    void listItemTypes(scopeId).then((result) => {
      if (!current) {
        return
      }
      setTypes(result.ok ? result.data : [])
      setTypesLoading(false)
      if (!result.ok) {
        setError(result.message)
      }
    })
    return () => {
      current = false
    }
  }, [scopeId, listItemTypes])

  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const canSubmit = scopeId !== '' && typeId !== '' && trimmedTitle !== '' && !submitting

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (inFlight.current || !canSubmit) {
      return
    }
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    const result = await createItem({
      scopeId,
      typeId,
      title: trimmedTitle,
      ...(trimmedDescription === '' ? {} : { description: trimmedDescription })
    })
    inFlight.current = false
    setSubmitting(false)
    // Every field survives a failure: losing a typed title to a transient
    // outage costs more than the retry does.
    if (!result.ok) {
      setError(result.message)
      return
    }
    onCreated()
    onClose()
  }

  const typePlaceholder = typesLoading
    ? translate('auto.components.TaskPage.pluginTaskSourceCreateTypeLoading', 'Loading types...')
    : translate('auto.components.TaskPage.pluginTaskSourceCreateTypePlaceholder', 'Select a type')

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${fieldId}-project`}>
          {translate('auto.components.TaskPage.pluginTaskSourceCreateProject', 'Project')}
        </Label>
        <Select value={scopeId} onValueChange={setScopeId} disabled={submitting}>
          <SelectTrigger id={`${fieldId}-project`} className="w-full">
            <SelectValue
              placeholder={translate(
                'auto.components.TaskPage.pluginTaskSourceCreateProjectPlaceholder',
                'Select a project'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {scopes.map((scope) => (
              <SelectItem key={scope.id} value={scope.id}>
                {scope.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${fieldId}-type`}>
          {translate('auto.components.TaskPage.pluginTaskSourceCreateType', 'Type')}
        </Label>
        <Select
          value={typeId}
          onValueChange={setTypeId}
          disabled={submitting || typesLoading || types.length === 0}
        >
          <SelectTrigger id={`${fieldId}-type`} className="w-full">
            <SelectValue placeholder={typePlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {types.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${fieldId}-title`}>
          {translate('auto.components.TaskPage.pluginTaskSourceCreateTitle', 'Title')}
        </Label>
        <Input
          id={`${fieldId}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={submitting}
          autoFocus
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${fieldId}-description`}>
          {translate(
            'auto.components.TaskPage.pluginTaskSourceCreateDescription',
            'Description (optional)'
          )}
        </Label>
        <Textarea
          id={`${fieldId}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={submitting}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
          {translate('auto.components.TaskPage.pluginTaskSourceCreateCancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {submitting
            ? translate('auto.components.TaskPage.pluginTaskSourceCreateSubmitting', 'Creating...')
            : translate('auto.components.TaskPage.pluginTaskSourceCreateSubmit', 'Create')}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function TaskPagePluginSourceCreateButton({
  scopes,
  selectedScopeIds,
  ...control
}: PluginTaskSourceCreateControl & {
  scopes: PluginTaskScope[]
  selectedScopeIds: string[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = createLabel()

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => setOpen(true)}>
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      {/* Mounted per opening, so a cancelled draft never reappears in the next. */}
      {open ? (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setOpen(false)
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription>
                {translate(
                  'auto.components.TaskPage.pluginTaskSourceCreateHint',
                  'Opens a work item in the selected project.'
                )}
              </DialogDescription>
            </DialogHeader>
            <CreateItemForm
              scopes={scopes}
              defaultScopeId={unambiguousScopeId(selectedScopeIds)}
              onClose={() => setOpen(false)}
              {...control}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
