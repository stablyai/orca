import { useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
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
import { translate } from '@/i18n/i18n'
import { voloCreateTask } from '@/runtime/runtime-volo-client'
import { useAppStore } from '@/store'
import type { VoloBoard, VoloPriority } from '../../../../../shared/volo-types'
import { VOLO_PRIORITIES } from '../../../../../shared/volo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export type NewVoloTaskDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  board: VoloBoard | null
  sourceContext: TaskSourceContext | null
  onCreated: () => void
}

export function NewVoloTaskDialog({
  open,
  onOpenChange,
  board,
  sourceContext,
  onCreated
}: NewVoloTaskDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [columnId, setColumnId] = useState<string | null>(null)
  const [priority, setPriority] = useState<VoloPriority>('medium')
  const [submitting, setSubmitting] = useState(false)
  const defaultColumnId = useMemo(
    () =>
      board?.columns.find((column) => column.type === 'not_started')?.id ??
      board?.columns[0]?.id ??
      null,
    [board]
  )
  const selectedColumnId = columnId ?? defaultColumnId

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setTitle('')
      setDescription('')
      setColumnId(null)
      setPriority('medium')
    }
    onOpenChange(next)
  }

  const handleCreate = async (): Promise<void> => {
    if (!board || !selectedColumnId || !title.trim()) {
      return
    }
    setSubmitting(true)
    const result = await voloCreateTask(sourceContext ?? settings, {
      boardId: board.id,
      title: title.trim(),
      columnId: selectedColumnId,
      description: description.trim() || undefined,
      priority
    })
    setSubmitting(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    handleOpenChange(false)
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.voloNewTaskTitle', 'New Volo task')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{translate('auto.components.TaskPage.voloTaskTitle', 'Title')}</Label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{translate('auto.components.TaskPage.voloColumn', 'Column')}</Label>
              <Select
                value={selectedColumnId ?? undefined}
                onValueChange={(value) => setColumnId(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(board?.columns ?? []).map((column) => (
                    <SelectItem key={column.id} value={column.id}>
                      {column.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{translate('auto.components.TaskPage.voloPriority', 'Priority')}</Label>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as VoloPriority)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOLO_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{translate('auto.components.TaskPage.voloDescription', 'Description')}</Label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={!title.trim() || !selectedColumnId || submitting}
            onClick={() => void handleCreate()}
          >
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {translate('auto.components.TaskPage.voloCreate', 'Create task')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
