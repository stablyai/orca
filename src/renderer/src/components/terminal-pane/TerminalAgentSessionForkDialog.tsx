import { Copy, FolderOpen, GitFork } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  copyAgentSessionForkContext,
  preflightAgentSessionFork,
  startAgentSessionFork,
  type PreparedAgentSessionFork
} from './terminal-agent-session-fork'
import {
  CURRENT_FORK_POINT_VALUE,
  formatForkPointOptionLabel,
  getMessageIdFromForkPointValue,
  toMessageForkPointValue
} from './terminal-agent-session-fork-points'
import {
  getPreflightDescription,
  type PreflightState
} from './terminal-agent-session-fork-preflight-text'
import { translate } from '@/i18n/i18n'
import type { RuntimeAgentSessionForkPointOption } from '../../../../shared/runtime-types'

type ForkTargetMode = 'child-workspace' | 'same-workspace'

type TerminalAgentSessionForkDialogProps = {
  open: boolean
  fork: PreparedAgentSessionFork | null
  onOpenChange: (open: boolean) => void
}

function isForkTargetMode(value: string): value is ForkTargetMode {
  return value === 'child-workspace' || value === 'same-workspace'
}

export function TerminalAgentSessionForkDialog({
  open,
  fork,
  onOpenChange
}: TerminalAgentSessionForkDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [targetMode, setTargetMode] = useState<ForkTargetMode>('child-workspace')
  const [forkName, setForkName] = useState('')
  const [openAfterCreate, setOpenAfterCreate] = useState(true)
  const [selectedForkPointValue, setSelectedForkPointValue] = useState(CURRENT_FORK_POINT_VALUE)
  const [forkPointOptions, setForkPointOptions] = useState<RuntimeAgentSessionForkPointOption[]>([])
  const [preflight, setPreflight] = useState<PreflightState>({ status: 'idle' })
  const forkNameId = useId()
  const forkPointId = useId()
  const openAfterCreateId = useId()
  const busyRef = useRef(false)
  const noCopyFiles = targetMode === 'same-workspace'
  const trimmedForkName = forkName.trim()
  const usesRuntimeForkService = Boolean(fork?.terminalHandle)
  const selectedForkPointMessage = getMessageIdFromForkPointValue(selectedForkPointValue)
  const targetIcon =
    targetMode === 'child-workspace' ? (
      <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    ) : (
      <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    )

  useEffect(() => {
    if (!open) {
      setTargetMode('child-workspace')
      setForkName('')
      setOpenAfterCreate(true)
      setSelectedForkPointValue(CURRENT_FORK_POINT_VALUE)
      setForkPointOptions([])
      setPreflight({ status: 'idle' })
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    setSelectedForkPointValue(CURRENT_FORK_POINT_VALUE)
    setForkPointOptions([])
  }, [fork?.terminalHandle, open])

  useEffect(() => {
    if (selectedForkPointValue === CURRENT_FORK_POINT_VALUE) {
      return
    }
    const selectedMessage = getMessageIdFromForkPointValue(selectedForkPointValue)
    if (!selectedMessage) {
      setSelectedForkPointValue(CURRENT_FORK_POINT_VALUE)
      return
    }
    if (
      forkPointOptions.length > 0 &&
      !forkPointOptions.some((option) => option.forkPoint.id === selectedMessage)
    ) {
      setSelectedForkPointValue(CURRENT_FORK_POINT_VALUE)
    }
  }, [forkPointOptions, selectedForkPointValue])

  useEffect(() => {
    if (!open || !fork || !fork.terminalHandle) {
      setPreflight({ status: 'idle' })
      setForkPointOptions([])
      return
    }
    let cancelled = false
    setPreflight({ status: 'loading' })
    preflightAgentSessionFork(fork, {
      noCopyFiles,
      ...(selectedForkPointMessage ? { message: selectedForkPointMessage } : {})
    })
      .then((result) => {
        if (cancelled) {
          return
        }
        setForkPointOptions(result?.availableForkPoints ?? [])
        setPreflight(result ? { status: 'ready', result } : { status: 'idle' })
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        setPreflight({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.preflightUnknownError',
                  'Preflight failed'
                )
        })
      })
    return () => {
      cancelled = true
    }
  }, [fork, noCopyFiles, open, selectedForkPointMessage])

  const handleCopyContext = async (): Promise<void> => {
    if (!fork || busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      if (await copyAgentSessionForkContext(fork)) {
        onOpenChange(false)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleStartFork = async (): Promise<void> => {
    if (!fork || busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      if (
        await startAgentSessionFork(fork, {
          activate: openAfterCreate,
          noCopyFiles,
          ...(selectedForkPointMessage ? { message: selectedForkPointMessage } : {}),
          ...(!noCopyFiles && trimmedForkName ? { name: trimmedForkName } : {})
        })
      ) {
        onOpenChange(false)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (busyRef.current && !nextOpen) {
      return
    }
    onOpenChange(nextOpen)
  }

  const handleTargetModeChange = (value: string): void => {
    if (isForkTargetMode(value)) {
      setTargetMode(value)
    }
  }

  const handleOpenAfterCreateChange = (checked: boolean | 'indeterminate'): void => {
    setOpenAfterCreate(checked === true)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.64e292e8e3',
              'Fork Agent Session'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.619b5a35d2',
              'Start a fresh agent tab with captured context. Choose whether to create a child workspace or stay in this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.targetModeLabel',
              'Target'
            )}
          </p>
          <ToggleGroup
            type="single"
            value={targetMode}
            onValueChange={handleTargetModeChange}
            disabled={busy}
            variant="outline"
            size="sm"
            className="grid w-full grid-cols-2"
            aria-label={translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.targetModeAriaLabel',
              'Fork target'
            )}
          >
            <ToggleGroupItem value="child-workspace" className="h-auto justify-start gap-2 py-2">
              <GitFork className="size-3.5" />
              <span className="truncate">
                {translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.childWorkspaceOption',
                  'Child workspace'
                )}
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="same-workspace" className="h-auto justify-start gap-2 py-2">
              <FolderOpen className="size-3.5" />
              <span className="truncate">
                {translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.currentWorkspaceOption',
                  'Current workspace'
                )}
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {forkPointOptions.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor={forkPointId} className="text-xs text-muted-foreground">
              {translate(
                'auto.components.terminal.pane.TerminalAgentSessionForkDialog.forkPointLabel',
                'Fork point'
              )}
            </Label>
            <Select
              value={selectedForkPointValue}
              onValueChange={setSelectedForkPointValue}
              disabled={busy}
            >
              <SelectTrigger id={forkPointId} size="sm" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="start"
                className="w-[var(--radix-select-trigger-width)]"
              >
                <SelectGroup>
                  <SelectItem value={CURRENT_FORK_POINT_VALUE}>
                    {translate(
                      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.currentForkPointOption',
                      'Current end'
                    )}
                  </SelectItem>
                  {forkPointOptions.map((option, index) => (
                    <SelectItem
                      key={option.forkPoint.id}
                      value={toMessageForkPointValue(option.forkPoint.id)}
                    >
                      <span className="truncate">{formatForkPointOptionLabel(option, index)}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor={forkNameId} className="text-xs text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.nameLabel',
              'Workspace name'
            )}
          </Label>
          <Input
            id={forkNameId}
            value={forkName}
            onChange={(event) => setForkName(event.target.value)}
            disabled={busy || noCopyFiles}
            placeholder={translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.namePlaceholder',
              'Auto-generate from source workspace'
            )}
          />
          {noCopyFiles ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.terminal.pane.TerminalAgentSessionForkDialog.nameDisabledForCurrentWorkspace',
                'Current workspace forks do not create a new workspace to name.'
              )}
            </p>
          ) : null}
        </div>

        <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
          {targetIcon}
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">
              {targetMode === 'child-workspace'
                ? translate(
                    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.620461df22',
                    'Child workspace fork'
                  )
                : translate(
                    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.currentWorkspaceTitle',
                    'Current workspace fork'
                  )}
            </p>
            <p className="text-xs text-muted-foreground">
              {targetMode === 'child-workspace'
                ? translate(
                    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.0c8a8629b1',
                    'The fork appears under the source workspace. The new agent receives a bounded transcript as an editable draft.'
                  )
                : translate(
                    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.currentWorkspaceDescription',
                    'No files are copied. The new agent opens in the source workspace with the same captured context.'
                  )}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-3">
          <Checkbox
            id={openAfterCreateId}
            checked={openAfterCreate}
            onCheckedChange={handleOpenAfterCreateChange}
            disabled={busy}
            className="mt-0.5"
          />
          <div className="min-w-0 space-y-1">
            <Label htmlFor={openAfterCreateId}>
              {translate(
                'auto.components.terminal.pane.TerminalAgentSessionForkDialog.openAfterCreateLabel',
                'Open after creating'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.terminal.pane.TerminalAgentSessionForkDialog.openAfterCreateDescription',
                'When off, Orca creates the fork without switching to the target workspace or terminal.'
              )}
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {getPreflightDescription({ preflight, usesRuntimeForkService })}
        </p>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void handleCopyContext()}>
            <Copy className="size-4" />
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.17fc841e59',
              'Copy context'
            )}
          </Button>
          <Button disabled={busy} onClick={() => void handleStartFork()}>
            <GitFork className="size-4" />
            {busy
              ? translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.2b10412cfc',
                  'Creating...'
                )
              : translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.9d25de2920',
                  'Create fork'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
