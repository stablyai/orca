import { useEffect, useState } from 'react'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL, type Room } from './room-types'
import { readAgentModels, type CatalogModel } from './room-model-catalog'

/** New groups get a leader automatically; model tuning stays out of the first screen. */
export function CreateRoomDialog(props: { onCreated: () => void; variant?: 'button' | 'icon' }) {
  useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [models, setModels] = useState<CatalogModel[]>([])
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const worktreeId = activeWorktreeId ?? worktrees[0]?.id

  useEffect(() => {
    if (!open || !worktreeId) {
      return
    }
    let live = true
    void readAgentModels('codex', worktreeId).then((listed) => {
      if (live) {
        setModels(listed)
      }
    })
    return () => {
      live = false
    }
  }, [open, worktreeId])

  const submit = async () => {
    if (!name.trim()) {
      toast.error(translate('auto.components.rooms.createRoom.nameRequired', 'Name is required'))
      return
    }
    if (!worktreeId) {
      toast.error(
        translate('auto.components.rooms.spawnBot.pickWorkspace', 'Pick a workspace for the bot')
      )
      return
    }
    setBusy(true)
    try {
      const created = await callRuntimeRpc<{ room: Room }>(LOCAL, 'orchestration.roomCreate', {
        name: name.trim(),
        mode: 'admin',
        worktree: `id:${worktreeId}`
      })
      try {
        await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
          id: created.room.id,
          worktree: `id:${worktreeId}`,
          agent: 'codex',
          model: model.trim() || undefined,
          effort: effort || undefined,
          name: 'admin',
          isAdmin: true,
          instructions: goal.trim() || undefined
        })
      } catch (botError) {
        toast.error(
          `${translate('auto.components.rooms.createRoom.adminFailed', 'Room created, but its admin bot failed')}: ${
            botError instanceof Error ? botError.message : String(botError)
          }`
        )
      }
      toast.success(
        translate('auto.components.rooms.createRoom.created', 'Room "{{name}}" created', {
          name: name.trim()
        })
      )
      setName('')
      setGoal('')
      setModel('')
      setEffort('')
      setOpen(false)
      props.onCreated()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.createRoom.failed', 'Failed to create room')}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setBusy(false)
    }
  }

  const selectedModel = models.find((item) => item.id === model)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size={props.variant === 'icon' ? 'icon-sm' : 'sm'}
          variant={props.variant === 'icon' ? 'ghost' : 'default'}
          className={props.variant === 'icon' ? undefined : 'w-full'}
          aria-label={translate('auto.components.rooms.createRoom.newRoom', 'New group')}
        >
          <Plus className="h-4 w-4" />
          {props.variant === 'icon' ? null : (
            <span>{translate('auto.components.rooms.createRoom.newRoom', 'New group')}</span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.rooms.createRoom.title', 'New group')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.rooms.createRoom.description',
              'A leader bot is added automatically. You can also ask Orca Admin to do this in chat.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder={translate(
              'auto.components.rooms.createRoom.namePlaceholder',
              'Group name'
            )}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
          <Input
            placeholder={translate(
              'auto.components.rooms.createRoom.briefPlaceholder',
              'What should this group do? (optional)'
            )}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            disabled={busy}
          />
          <details className="rounded-md border border-border/60 px-3 py-2">
            <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <ChevronDown className="size-3.5" />
              {translate('auto.components.rooms.createRoom.advanced', 'Advanced')}
            </summary>
            <div className="mt-3 space-y-2">
              {models.length > 0 ? (
                <Select
                  value={model || '_default'}
                  onValueChange={(v) => {
                    setModel(v === '_default' ? '' : v)
                    setEffort('')
                  }}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_default">
                      {translate(
                        'auto.components.rooms.createRoom.modelDefault',
                        '(agent default)'
                      )}
                    </SelectItem>
                    {models.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {selectedModel?.efforts.length ? (
                <Select
                  value={effort || '_default'}
                  onValueChange={(v) => setEffort(v === '_default' ? '' : v)}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_default">
                      {translate(
                        'auto.components.rooms.createRoom.effortDefault',
                        '(default thinking)'
                      )}
                    </SelectItem>
                    {selectedModel.efforts.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          </details>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {translate('auto.components.rooms.createRoom.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {translate('auto.components.rooms.createRoom.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
