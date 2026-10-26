import { useEffect, useState } from 'react'
import { Bot, Loader2, Sparkles } from 'lucide-react'
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
import { useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { BOT_AGENTS, LOCAL } from './room-types'
import { readAgentModels, type CatalogModel } from './room-model-catalog'

/** Spawn a new structured agent session into this room as a member. */
export function SpawnBotForm(props: {
  roomId: string
  onSpawned: () => void
  onCancel: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<string>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [worktreeId, setWorktreeId] = useState<string>(activeWorktreeId ?? worktrees[0]?.id ?? '')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<CatalogModel[]>([])

  useEffect(() => {
    if (!worktreeId && worktrees.length > 0) {
      setWorktreeId(worktrees[0].id)
    }
  }, [worktreeId, worktrees])

  useEffect(() => {
    if (!worktreeId) {
      return
    }
    let live = true
    void readAgentModels(agent, worktreeId).then((listed) => {
      if (live) {
        setModels(listed)
      }
    })
    return () => {
      live = false
    }
  }, [agent, worktreeId])

  const submit = async () => {
    if (!name.trim()) {
      toast.error(translate('auto.components.rooms.spawnBot.needsName', 'Bot needs a name'))
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
      await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
        id: props.roomId,
        worktree: `id:${worktreeId}`,
        agent,
        model: model.trim() || undefined,
        effort: effort || undefined,
        name: name.trim(),
        instructions: instructions.trim() || undefined
      })
      toast.success(
        translate('auto.components.rooms.spawnBot.joined', 'Bot "{{name}}" joined the room', {
          name: name.trim()
        })
      )
      props.onSpawned()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.spawnBot.failed', 'Failed to spawn bot')}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Bot className="h-3.5 w-3.5" />{' '}
        {translate('auto.components.rooms.spawnBot.title', 'New bot')}
      </div>
      <Input
        placeholder={translate(
          'auto.components.rooms.spawnBot.namePlaceholder',
          'Name (e.g. reviewer, planner)'
        )}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      <Input
        placeholder={translate(
          'auto.components.rooms.spawnBot.instructionsPlaceholder',
          'What is this bot responsible for? (optional)'
        )}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={busy}
      />
      <Select value={agent} onValueChange={setAgent} disabled={busy}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BOT_AGENTS.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <details className="rounded-md border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {translate('auto.components.rooms.spawnBot.advanced', 'Advanced')}
        </summary>
        <div className="mt-2 space-y-2">
          <Select
            value={worktreeId || '_none'}
            onValueChange={(v) => setWorktreeId(v === '_none' ? '' : v)}
            disabled={busy}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {worktrees.length === 0 ? (
                <SelectItem value="_none">
                  {translate('auto.components.rooms.spawnBot.noWorkspace', '(no workspace)')}
                </SelectItem>
              ) : null}
              {worktrees.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                  {translate('auto.components.rooms.spawnBot.modelDefault', '(agent default)')}
                </SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {(() => {
            const picked = models.find((m) => m.id === model)
            if (!picked || picked.efforts.length === 0) {
              return null
            }
            return (
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
                      'auto.components.rooms.spawnBot.effortDefault',
                      '(default thinking)'
                    )}
                  </SelectItem>
                  {picked.efforts.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          })()}
        </div>
      </details>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          {translate('auto.components.rooms.spawnBot.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {translate('auto.components.rooms.spawnBot.spawn', 'Spawn')}
        </Button>
      </div>
    </div>
  )
}
