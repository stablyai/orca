import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import {
  isAiVaultSessionResumableContent,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { isAiVaultSessionInWorkspacePath } from '../../../../shared/ai-vault-session-filters'
import type { RoomAttachableAgent, RoomHarnessAgent } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { showRoomActionError } from './room-action-error'
import type { Worktree } from '../../../../shared/worktree/types'

const AGENTS: RoomHarnessAgent[] = ['claude', 'openclaude', 'codex', 'grok']
type Mode = 'launch' | 'attach' | 'resume'
const MODE_LABELS: Record<Mode, [string, string]> = {
  launch: ['rooms.addAgent.mode.launch', 'Launch'],
  attach: ['rooms.addAgent.mode.attach', 'Attach'],
  resume: ['rooms.addAgent.mode.resume', 'Resume']
}
const MODE_DESCRIPTIONS: Record<Mode, [string, string]> = {
  launch: ['rooms.addAgent.mode.launchDescription', 'Start a new clean agent session.'],
  attach: [
    'rooms.addAgent.mode.attachDescription',
    'Use an agent that is already running in this worktree.'
  ],
  resume: [
    'rooms.addAgent.mode.resumeDescription',
    'Continue a local conversation from Agent Session History.'
  ]
}

export function RoomAddAgentDialog({
  open,
  onOpenChange,
  roomId,
  worktreeId,
  worktrees,
  target
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string | null
  worktreeId: string | null
  worktrees: Worktree[]
  target: RuntimeClientTarget
}): React.JSX.Element {
  const [agent, setAgent] = useState<RoomHarnessAgent>('claude')
  const [mode, setMode] = useState<Mode>('launch')
  const [identity, setIdentity] = useState('claude')
  const [attachable, setAttachable] = useState<RoomAttachableAgent[]>([])
  const [sessions, setSessions] = useState<AiVaultSession[]>([])
  const [selection, setSelection] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingChoices, setLoadingChoices] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [choosing, setChoosing] = useState(false)
  const worktree = worktrees.find((item) => item.id === worktreeId)
  useEffect(() => setIdentity(agent), [agent])
  useEffect(() => {
    if (!open || !worktree?.id) {
      return
    }
    let disposed = false
    setLoadingChoices(true)
    setLoadError('')
    void Promise.all([
      roomRpc<{ participants: RoomAttachableAgent[] }>(target, 'rooms.participants.attachable', {
        worktreeId: worktree.id
      }),
      roomRpc<AiVaultListResult>(target, 'aiVault.listSessions', {
        unlimited: true,
        scopePaths: [worktree.path]
      })
    ]).then(
      ([live, history]) => {
        if (disposed) {
          return
        }
        setAttachable(live.participants)
        setSessions(history.sessions)
        setLoadingChoices(false)
      },
      (error) => {
        if (disposed) {
          return
        }
        setAttachable([])
        setSessions([])
        setLoadingChoices(false)
        setLoadError(error instanceof Error ? error.message : 'Failed to load sessions')
      }
    )
    return () => {
      disposed = true
    }
  }, [open, target, worktree?.id, worktree?.path])
  const choices = useMemo(() => {
    if (mode === 'attach') {
      return attachable.filter((item) => item.agent === agent)
    }
    const worktreePath = worktree?.path
    if (!worktreePath) {
      return []
    }
    return sessions.filter(
      (item) =>
        item.agent === (agent === 'openclaude' ? 'claude' : agent) &&
        isAiVaultSessionResumableContent(item) &&
        item.cwd !== null &&
        isAiVaultSessionInWorkspacePath(worktreePath, item.cwd)
    )
  }, [agent, attachable, mode, sessions, worktree?.path])

  const add = async (): Promise<void> => {
    if (!roomId || !worktree || !identity.trim()) {
      return
    }
    const selected = choices.find((item) =>
      'terminalHandle' in item ? item.terminalHandle === selection : item.id === selection
    )
    const connection =
      mode === 'launch'
        ? { kind: 'launch', worktreeId: worktree.id }
        : mode === 'attach' && selected && 'terminalHandle' in selected
          ? {
              kind: 'attach',
              worktreeId: worktree.id,
              terminalHandle: selected.terminalHandle,
              paneKey: selected.paneKey
            }
          : mode === 'resume' && selected && 'sessionId' in selected
            ? {
                kind: 'resume',
                worktreeId: worktree.id,
                historyId: selected.id
              }
            : null
    if (!connection) {
      return
    }
    setSaving(true)
    try {
      await roomRpc(target, 'rooms.participants.add', {
        roomId,
        identity: identity.trim(),
        displayName: identity.trim(),
        agent,
        connection
      })
      onOpenChange(false)
      setSelection('')
    } catch (error) {
      showRoomActionError(error)
    } finally {
      setSaving(false)
    }
  }

  const selected = choices.find((item) =>
    'terminalHandle' in item ? item.terminalHandle === selection : item.id === selection
  )

  const choose = (item: RoomAttachableAgent | AiVaultSession): void => {
    setSelection('terminalHandle' in item ? item.terminalHandle : item.id)
    setChoosing(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{translate('rooms.addAgent.title', 'Add agent')}</DialogTitle>
          <DialogDescription>
            {choosing
              ? mode === 'attach'
                ? translate('rooms.addAgent.chooseRunning', 'Choose a running {{agent}} session.', {
                    agent
                  })
                : translate('rooms.addAgent.chooseHistory', 'Choose local {{agent}} history.', {
                    agent
                  })
              : translate(
                  'rooms.addAgent.description',
                  'Launch a clean harness, attach a running one, or resume local history.'
                )}
          </DialogDescription>
        </DialogHeader>
        {choosing ? (
          <Command className="min-w-0 border border-border bg-background">
            <CommandInput
              autoFocus
              placeholder={translate('rooms.addAgent.searchSessions', 'Search sessions…')}
            />
            <CommandList className="h-72 max-h-[45vh]">
              <CommandEmpty>
                {loadingChoices
                  ? translate('rooms.addAgent.loadingSessions', 'Loading sessions…')
                  : loadError ||
                    translate('rooms.addAgent.noMatchingSessions', 'No matching sessions found.')}
              </CommandEmpty>
              {choices.map((item) => {
                const live = 'terminalHandle' in item
                const value = live ? item.terminalHandle : item.id
                return (
                  <CommandItem
                    key={value}
                    value={`${item.title || value} ${live ? '' : item.model || ''} ${value}`}
                    onSelect={() => choose(item)}
                    className="min-w-0 items-start py-2"
                  >
                    <Check className={cn('mt-0.5 size-4', selection !== value && 'invisible')} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.title || value}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {live
                          ? translate('rooms.addAgent.runningNow', 'Running now')
                          : [
                              item.model,
                              new Date(item.updatedAt ?? item.modifiedAt).toLocaleString()
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </div>
                    </div>
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        ) : (
          <div className="grid min-w-0 gap-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {translate('rooms.addAgent.harness', 'Harness')}
              <select
                value={agent}
                onChange={(event) => {
                  setAgent(event.target.value as RoomHarnessAgent)
                  setSelection('')
                }}
                className="min-w-0 rounded-md border border-border bg-background p-2 text-sm text-foreground"
              >
                {AGENTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {translate('rooms.addAgent.identity', 'Room identity')}
              <Input value={identity} onChange={(event) => setIdentity(event.target.value)} />
            </label>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
              {(['launch', 'attach', 'resume'] as Mode[]).map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-pressed={mode === item}
                  className={cn(
                    mode === item &&
                      'border border-border bg-background text-foreground shadow-xs hover:bg-background'
                  )}
                  onClick={() => {
                    setMode(item)
                    setSelection('')
                    setChoosing(item !== 'launch')
                  }}
                >
                  {translate(...MODE_LABELS[item])}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{translate(...MODE_DESCRIPTIONS[mode])}</p>
            {mode !== 'launch' ? (
              <Button
                type="button"
                variant="outline"
                className="min-w-0 justify-between font-normal"
                disabled={loadingChoices}
                onClick={() => setChoosing(true)}
              >
                <span className="min-w-0 truncate text-left">
                  {selected
                    ? selected.title ||
                      ('terminalHandle' in selected ? selected.terminalHandle : selected.id)
                    : loadingChoices
                      ? translate('rooms.addAgent.loadingSessions', 'Loading sessions…')
                      : translate('rooms.addAgent.chooseSession', 'Choose session…')}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
              </Button>
            ) : null}
            {loadError ? (
              <span className="text-xs text-destructive" role="alert">
                {loadError}
              </span>
            ) : null}
          </div>
        )}
        {choosing ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setChoosing(false)}
              className="mr-auto"
            >
              <ArrowLeft />
              {translate('rooms.common.back', 'Back')}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter showCloseButton>
            <Button
              onClick={() => void add()}
              disabled={
                saving ||
                !roomId ||
                !worktree ||
                // The attachable/history prefetch only feeds Attach and Resume.
                (mode !== 'launch' && (loadingChoices || !selection))
              }
            >
              {translate('rooms.addAgent.title', 'Add agent')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
