import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ChevronsUpDown, Loader2 } from 'lucide-react'
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
import type { RoomExistingAgentCandidate, RoomHarnessAgent } from '../../../../shared/rooms'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { showRoomActionError } from './room-action-error'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  isStructuredMachineAgentEnabled,
  type StructuredMachineAgent
} from '../../../../shared/structured-agent-provider'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import {
  ROOM_EXISTING_STRUCTURED_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

const AGENTS: RoomHarnessAgent[] = ['claude', 'openclaude', 'codex', 'grok', 'omp']
type Mode = 'new' | 'existing'
const MODE_LABELS: Record<Mode, [string, string]> = {
  new: ['rooms.addAgent.mode.new', 'New'],
  existing: ['rooms.addAgent.mode.existing', 'Existing']
}
const MODE_DESCRIPTIONS: Record<Mode, [string, string]> = {
  new: ['rooms.addAgent.mode.newDescription', 'Start a new clean agent session.'],
  existing: [
    'rooms.addAgent.mode.existingDescription',
    'Add a running agent or continue a session from history.'
  ]
}

export function RoomAddAgentDialog({
  open,
  onOpenChange,
  roomId,
  worktreeId,
  worktrees,
  target,
  machineStreaming,
  enabledStreamingAgents
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomId: string | null
  worktreeId: string | null
  worktrees: Worktree[]
  target: RuntimeClientTarget
  machineStreaming: boolean
  enabledStreamingAgents?: StructuredMachineAgent[]
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const [agent, setAgent] = useState<RoomHarnessAgent>('claude')
  const [mode, setMode] = useState<Mode>('new')
  const [identity, setIdentity] = useState('claude')
  const [choices, setChoices] = useState<RoomExistingAgentCandidate[]>([])
  const [selection, setSelection] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingChoices, setLoadingChoices] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [existingMachineSupported, setExistingMachineSupported] = useState(false)
  const worktree = worktrees.find((item) => item.id === worktreeId)
  useEffect(() => setIdentity(agent), [agent])
  useEffect(() => {
    if (!open || mode !== 'existing' || !worktree?.id) {
      return
    }
    let disposed = false
    setChoices([])
    setExistingMachineSupported(false)
    setLoadingChoices(true)
    setLoadError('')
    const load = async (): Promise<void> => {
      const machineSupported =
        machineStreaming &&
        isStructuredMachineAgentEnabled(agent, enabledStreamingAgents) &&
        (target.kind === 'local' ||
          (await runtimeEnvironmentSupportsCapability(
            target.environmentId,
            ROOM_EXISTING_STRUCTURED_SESSION_RUNTIME_CAPABILITY
          )))
      const { participants } = await roomRpc<{ participants: RoomExistingAgentCandidate[] }>(
        target,
        'rooms.participants.existing',
        {
          worktreeId: worktree.id,
          agent,
          ...(machineSupported ? { machineStreaming: true } : {})
        }
      )
      if (!disposed) {
        setExistingMachineSupported(machineSupported)
        setChoices(participants)
        setLoadingChoices(false)
      }
    }
    void load().catch((error) => {
      if (!disposed) {
        setChoices([])
        setLoadingChoices(false)
        setLoadError(error instanceof Error ? error.message : 'Failed to load sessions')
      }
    })
    return () => {
      disposed = true
    }
  }, [agent, enabledStreamingAgents, machineStreaming, mode, open, target, worktree?.id])

  const add = async (): Promise<void> => {
    if (!roomId || !worktree || !identity.trim()) {
      return
    }
    const selected = choices.find((item) => item.id === selection)
    const useMachineStreaming =
      mode === 'existing'
        ? existingMachineSupported
        : machineStreaming &&
          isStructuredMachineAgentEnabled(agent, enabledStreamingAgents) &&
          (target.kind === 'local' ||
            (await runtimeEnvironmentSupportsCapability(
              target.environmentId,
              STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
            )))
    const trusted =
      !useMachineStreaming ||
      (agent !== 'claude' && agent !== 'openclaude') ||
      (await confirm({
        title: translate('rooms.addAgent.trustTitle', 'Trust this workspace?'),
        description: translate(
          'rooms.addAgent.trustDescription',
          'Claude project settings, instructions, and hooks may run from {{path}}.',
          { path: worktree.path }
        ),
        confirmLabel: translate('rooms.addAgent.trustConfirm', 'Trust and continue')
      }))
    if (!trusted) {
      return
    }
    const connection =
      mode === 'new'
        ? { kind: 'new', worktreeId: worktree.id }
        : selected
          ? {
              kind: 'existing',
              worktreeId: worktree.id,
              ...(selected.terminalHandle
                ? { terminalHandle: selected.terminalHandle, paneKey: selected.paneKey }
                : {}),
              ...(selected.historyId ? { historyId: selected.historyId } : {}),
              ...(useMachineStreaming && selected.conversationId
                ? { conversationId: selected.conversationId }
                : {})
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
        connection,
        ...(useMachineStreaming ? { machineStreaming: true, trusted: true } : {})
      })
      onOpenChange(false)
      setSelection('')
    } catch (error) {
      showRoomActionError(error)
    } finally {
      setSaving(false)
    }
  }

  const selected = choices.find((item) => item.id === selection)

  const choose = (item: RoomExistingAgentCandidate): void => {
    setSelection(item.id)
    setChoosing(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{translate('rooms.addAgent.title', 'Add agent')}</DialogTitle>
          <DialogDescription>
            {choosing
              ? translate(
                  'rooms.addAgent.chooseExisting',
                  'Choose an existing {{agent}} session.',
                  {
                    agent
                  }
                )
              : translate(
                  'rooms.addAgent.description',
                  'Start a new agent or add an existing session.'
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
                const value = item.id
                return (
                  <CommandItem
                    key={value}
                    value={`${item.title || value} ${item.model || ''} ${value}`}
                    onSelect={() => choose(item)}
                    className="min-w-0 items-start py-2"
                  >
                    <Check className={cn('mt-0.5 size-4', selection !== value && 'invisible')} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.title || value}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.status === 'running'
                          ? translate('rooms.addAgent.runningNow', 'Running now')
                          : [
                              translate('rooms.addAgent.history', 'History'),
                              item.model,
                              item.updatedAt ? new Date(item.updatedAt).toLocaleString() : null
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
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
              {(['new', 'existing'] as Mode[]).map((item) => (
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
                    setChoosing(item === 'existing')
                  }}
                >
                  {translate(...MODE_LABELS[item])}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{translate(...MODE_DESCRIPTIONS[mode])}</p>
            {mode === 'existing' ? (
              <Button
                type="button"
                variant="outline"
                className="min-w-0 justify-between font-normal"
                disabled={loadingChoices}
                onClick={() => setChoosing(true)}
              >
                <span className="min-w-0 truncate text-left">
                  {selected
                    ? selected.title || selected.id
                    : loadingChoices
                      ? translate('rooms.addAgent.loadingSessions', 'Loading sessions…')
                      : translate('rooms.addAgent.chooseSession', 'Choose session…')}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
              </Button>
            ) : null}
            {mode === 'existing' && loadError ? (
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
              className="relative"
              onClick={() => void add()}
              aria-label={saving ? translate('rooms.addAgent.adding', 'Adding agent…') : undefined}
              disabled={
                saving ||
                !roomId ||
                !worktree ||
                (mode === 'existing' && (loadingChoices || !selection))
              }
            >
              <span className={cn(saving && 'invisible')}>
                {translate('rooms.addAgent.title', 'Add agent')}
              </span>
              {saving ? (
                <span className="absolute" aria-hidden>
                  <Loader2 className="animate-spin" />
                </span>
              ) : null}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
