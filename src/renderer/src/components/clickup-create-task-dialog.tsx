import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ClickUpList, ClickUpTask, ClickUpWorkspaceSelection } from '../../../shared/clickup-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { clickUpCreateTask, clickUpListLists } from '@/runtime/runtime-clickup-client'
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
import { translate } from '@/i18n/i18n'

const textareaClassName =
  'w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

function listLabel(list: ClickUpList): string {
  return [list.workspaceName, list.space?.name, list.folder?.name, list.name]
    .filter(Boolean)
    .join(' / ')
}

export function ClickUpCreateTaskDialog({
  open,
  onOpenChange,
  workspaceId,
  sourceContext,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: ClickUpWorkspaceSelection | null
  sourceContext: TaskSourceContext | null
  onCreated: (task: ClickUpTask) => void
}): React.JSX.Element {
  const [lists, setLists] = useState<ClickUpList[]>([])
  const [listsLoading, setListsLoading] = useState(false)
  const [listId, setListId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setListsLoading(true)
    setError(null)
    void clickUpListLists(sourceContext, workspaceId)
      .then((nextLists) => {
        if (!cancelled) {
          setLists(nextLists)
          setListId((current) =>
            nextLists.some((list) => list.id === current) ? current : (nextLists[0]?.id ?? '')
          )
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load ClickUp Lists.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setListsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, sourceContext, workspaceId])

  const selectedList = useMemo(() => lists.find((list) => list.id === listId), [listId, lists])

  const handleOpenChange = (nextOpen: boolean): void => {
    if (submitting) {
      return
    }
    if (!nextOpen) {
      setName('')
      setDescription('')
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  const handleCreate = async (): Promise<void> => {
    if (!listId || !name.trim() || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await clickUpCreateTask(sourceContext, {
      workspaceId: selectedList?.workspaceId,
      listId,
      name: name.trim(),
      description: description.trim() || undefined
    }).catch((cause: unknown) => ({
      ok: false as const,
      error: cause instanceof Error ? cause.message : 'Task creation failed.'
    }))
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setName('')
    setDescription('')
    onOpenChange(false)
    onCreated(result.task)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.clickup.create.title', 'Create ClickUp task')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.clickup.create.description',
              'Choose the destination List, then add the task details.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">
              {translate('auto.components.clickup.create.list', 'List')}
            </Label>
            <Select value={listId} onValueChange={setListId} disabled={listsLoading}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    listsLoading
                      ? translate('auto.components.clickup.create.loadingLists', 'Loading Lists…')
                      : translate('auto.components.clickup.create.selectList', 'Select a List')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {lists.map((list) => (
                  <SelectItem key={`${list.workspaceId}:${list.id}`} value={list.id}>
                    {listLabel(list)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="clickup-create-name" className="text-xs">
              {translate('auto.components.clickup.create.name', 'Name')}
            </Label>
            <Input
              id="clickup-create-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clickup-create-description" className="text-xs">
              {translate('auto.components.clickup.create.taskDescription', 'Description')}
            </Label>
            <textarea
              id="clickup-create-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={6}
              disabled={submitting}
              className={textareaClassName}
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {translate('auto.components.clickup.create.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={!listId || !name.trim() || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                {translate('auto.components.clickup.create.creating', 'Creating…')}
              </>
            ) : (
              translate('auto.components.clickup.create.submit', 'Create task')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
