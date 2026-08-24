import React, { useCallback, useId, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { useRepoById } from '@/store/selectors'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { getExecutionHostLabel, getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { submitTerminalGroupCreate } from './new-terminal-group-submit'

type NewTerminalGroupModalData = {
  repoId?: string
}

export default function NewTerminalGroupDialog(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-terminal-group')
  const modalData = useAppStore((s) => s.modalData as NewTerminalGroupModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)
  const repoId = modalData?.repoId ?? null

  if (!visible || !repoId) {
    return null
  }

  return <NewTerminalGroupDialogBody repoId={repoId} onClose={closeModal} />
}

function NewTerminalGroupDialogBody({
  repoId,
  onClose
}: {
  repoId: string
  onClose: () => void
}): React.JSX.Element | null {
  const repo = useRepoById(repoId)
  const settings = useAppStore((s) => s.settings)
  const createTerminalGroup = useAppStore((s) => s.createTerminalGroup)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<TuiAgent | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()

  const agents = useMemo(() => {
    const enabledIds = new Set(
      filterEnabledTuiAgents(
        getAgentCatalog().map((entry) => entry.id),
        settings?.disabledTuiAgents
      )
    )
    const detected = detectedAgentIds === null ? null : new Set(detectedAgentIds)
    return getAgentCatalog().filter(
      (entry) => enabledIds.has(entry.id) && (detected === null || detected.has(entry.id))
    )
  }, [detectedAgentIds, settings?.disabledTuiAgents])

  const handleCreate = useCallback(async (): Promise<void> => {
    if (!repo || creating) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      await submitTerminalGroupCreate({
        repo,
        name,
        agent,
        platform: getAgentLaunchPlatformForRepo(
          repo,
          repo.connectionId
            ? undefined
            : getLocalProjectExecutionRuntimeContext(useAppStore.getState(), repoId)
        ),
        agentCmdOverrides: settings?.agentCmdOverrides,
        terminalWindowsShell: settings?.terminalWindowsShell,
        createTerminalGroup: (input) =>
          createTerminalGroup({ ...input, telemetrySource: 'sidebar' }),
        onOpenChange: (open) => {
          if (!open) {
            onClose()
          }
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [
    agent,
    createTerminalGroup,
    creating,
    name,
    onClose,
    repo,
    repoId,
    settings?.agentCmdOverrides,
    settings?.terminalWindowsShell
  ])

  if (!repo) {
    return null
  }

  const hostLabel = getExecutionHostLabel(getRepoExecutionHostId(repo))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-base font-semibold">
            {translate(
              'auto.components.sidebar.NewTerminalGroupDialog.title',
              'New terminal group'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.NewTerminalGroupDialog.description',
              'Terminals and agents that run in {{value0}} on {{value1}}. No new worktree, no branch.',
              { value0: repo.displayName, value1: hostLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>
              {translate('auto.components.sidebar.NewTerminalGroupDialog.nameLabel', 'Name')}
            </Label>
            <Input
              id={nameId}
              value={name}
              autoFocus
              placeholder={translate(
                'auto.components.sidebar.NewTerminalGroupDialog.namePlaceholder',
                'servers, research, scripts…'
              )}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !creating) {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>
              {translate('auto.components.sidebar.NewTerminalGroupDialog.agentLabel', 'Agent')}
            </Label>
            <AgentCombobox
              agents={agents}
              value={agent}
              onValueChange={setAgent}
              allowBlankTerminal
              allowNarrowTrigger
              triggerClassName="h-9 w-full min-w-0 border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={creating}>
            {translate('auto.components.sidebar.NewTerminalGroupDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleCreate()} disabled={creating}>
            {translate('auto.components.sidebar.NewTerminalGroupDialog.create', 'Create group')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
