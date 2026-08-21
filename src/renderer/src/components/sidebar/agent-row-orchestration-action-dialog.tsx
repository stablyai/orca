import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
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
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isOrchestrationSetupEnabled } from '@/lib/orchestration-setup-state'
import {
  askAgent,
  dispatchTaskToAgent,
  findActiveDispatchForWorker,
  formatCoordinatorWaitHint,
  listCoordinatorCandidates,
  resolveCoordinatorPaneKey,
  sendMessageToAgent,
  type OrchestrationActionKind
} from './agent-row-orchestration-actions'
import { dialogCopy } from './agent-row-orchestration-action-copy'
import { AgentRowOrchestrationCoordinatorPicker } from './agent-row-orchestration-coordinator-picker'
import {
  activeDispatchFromTarget,
  type AgentRowOrchestrationTarget
} from './worktree-agent-orchestration-menu'

export type AgentRowOrchestrationActionDialogState = {
  kind: OrchestrationActionKind
  target: AgentRowOrchestrationTarget
}

type Props = {
  state: AgentRowOrchestrationActionDialogState | null
  onOpenChange: (open: boolean) => void
}

export function AgentRowOrchestrationActionDialog({ state, onOpenChange }: Props) {
  const open = state != null
  const kind = state?.kind ?? 'dispatch'
  const target = state?.target
  const copy = useMemo(() => dialogCopy(kind), [kind])
  const [primary, setPrimary] = useState('')
  const [body, setBody] = useState('')
  const [inject, setInject] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [coordinatorPaneKey, setCoordinatorPaneKey] = useState<string>('')
  const [workerBusyMessage, setWorkerBusyMessage] = useState<string | null>(null)

  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const coordinatorOptions = useMemo(() => {
    if (!target) {
      return []
    }
    return listCoordinatorCandidates({
      workerPaneKey: target.paneKey,
      workerWorktreeId: target.worktreeId,
      state: {
        tabsByWorktree,
        terminalLayoutsByTabId,
        agentStatusByPaneKey,
        activeTabId,
        activeTabType,
        activeWorktreeId
      }
    })
  }, [
    target,
    tabsByWorktree,
    terminalLayoutsByTabId,
    agentStatusByPaneKey,
    activeTabId,
    activeTabType,
    activeWorktreeId
  ])

  useEffect(() => {
    if (!open || !target) {
      return
    }
    setPrimary('')
    setBody('')
    setInject(true)
    setSubmitting(false)
    setWorkerBusyMessage(null)
    const preferred =
      resolveCoordinatorPaneKey({
        workerPaneKey: target.paneKey,
        workerWorktreeId: target.worktreeId,
        state: useAppStore.getState()
      }) ?? ''
    setCoordinatorPaneKey(preferred)

    if (kind !== 'dispatch') {
      return
    }
    const known = activeDispatchFromTarget(target)
    if (known) {
      setWorkerBusyMessage(
        translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.busy',
          'This agent already has an active dispatch ({{dispatchId}} / task {{taskId}}). Wait for worker_done before dispatching again.',
          { dispatchId: known.dispatchId, taskId: known.taskId }
        )
      )
      return
    }
    let cancelled = false
    void findActiveDispatchForWorker({
      workerPaneKey: target.paneKey,
      callRuntime: window.api.runtime.call as (request: {
        method: string
        params?: Record<string, unknown>
      }) => ReturnType<typeof window.api.runtime.call>
    })
      .then((active) => {
        if (cancelled || !active) {
          return
        }
        setWorkerBusyMessage(
          translate(
            'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.busy',
            'This agent already has an active dispatch ({{dispatchId}} / task {{taskId}}). Wait for worker_done before dispatching again.',
            { dispatchId: active.dispatchId, taskId: active.taskId }
          )
        )
      })
      .catch(() => {
        // Best-effort probe; submit re-checks.
      })
    return () => {
      cancelled = true
    }
  }, [open, kind, target?.paneKey, target?.worktreeId, target])

  const submit = async (): Promise<void> => {
    if (!target) {
      return
    }
    if (!isOrchestrationSetupEnabled()) {
      toast.error(
        translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.disabled',
          'Enable Orchestration in Settings → Experimental first'
        )
      )
      return
    }
    if (!coordinatorPaneKey) {
      toast.error(
        translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.no.coordinator',
          'Select a coordinator terminal (must be different from this agent)'
        )
      )
      return
    }
    if (kind === 'dispatch' && workerBusyMessage) {
      toast.error(workerBusyMessage)
      return
    }
    setSubmitting(true)
    try {
      // Why: window.api.runtime.call is a method-union; actions accept a narrow
      // call surface for taskCreate/dispatch/send/ask + terminal.resolvePane.
      const callRuntime = window.api.runtime.call as (request: {
        method: string
        params?: Record<string, unknown>
      }) => ReturnType<typeof window.api.runtime.call>

      if (kind === 'dispatch') {
        const result = await dispatchTaskToAgent({
          workerPaneKey: target.paneKey,
          coordinatorPaneKey,
          spec: primary,
          inject,
          callRuntime
        })
        toast.success(
          translate(
            'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.success',
            'Dispatched {{taskId}} to {{handle}}{{injected}}',
            {
              taskId: result.taskId,
              handle: result.workerHandle,
              injected: result.injected ? ' (injected)' : ''
            }
          ),
          {
            description: formatCoordinatorWaitHint(),
            duration: 12_000
          }
        )
      } else if (kind === 'send') {
        const result = await sendMessageToAgent({
          workerPaneKey: target.paneKey,
          coordinatorPaneKey,
          subject: primary,
          body,
          callRuntime
        })
        toast.success(
          translate(
            'auto.components.sidebar.agent.row.orchestration.action.dialog.send.success',
            'Message sent to {{handle}}',
            { handle: result.workerHandle }
          )
        )
      } else {
        const result = await askAgent({
          workerPaneKey: target.paneKey,
          coordinatorPaneKey,
          question: primary,
          callRuntime
        })
        toast.success(
          translate(
            'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.success',
            'Question sent to {{handle}}',
            { handle: result.workerHandle }
          ),
          {
            description: formatCoordinatorWaitHint(),
            duration: 12_000
          }
        )
      }
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {workerBusyMessage ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {workerBusyMessage}
            </p>
          ) : null}
          <AgentRowOrchestrationCoordinatorPicker
            options={coordinatorOptions}
            value={coordinatorPaneKey}
            disabled={submitting || Boolean(workerBusyMessage)}
            onChange={setCoordinatorPaneKey}
          />
          <div className="space-y-2">
            <Label htmlFor="orchestration-action-primary">{copy.primaryFieldLabel}</Label>
            {kind === 'dispatch' || kind === 'ask' ? (
              <textarea
                id="orchestration-action-primary"
                autoFocus
                rows={kind === 'dispatch' ? 5 : 3}
                value={primary}
                placeholder={copy.primaryPlaceholder}
                onChange={(e) => setPrimary(e.target.value)}
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[80px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
              />
            ) : (
              <Input
                id="orchestration-action-primary"
                autoFocus
                value={primary}
                placeholder={copy.primaryPlaceholder}
                onChange={(e) => setPrimary(e.target.value)}
                disabled={submitting}
              />
            )}
          </div>
          {kind === 'send' ? (
            <div className="space-y-2">
              <Label htmlFor="orchestration-action-body">
                {translate(
                  'auto.components.sidebar.agent.row.orchestration.action.dialog.send.body',
                  'Body (optional)'
                )}
              </Label>
              <textarea
                id="orchestration-action-body"
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[72px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
              />
            </div>
          ) : null}
          {kind === 'dispatch' ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={inject}
                onChange={(e) => setInject(e.target.checked)}
                disabled={submitting}
              />
              {translate(
                'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.inject',
                'Inject task into agent CLI (requires a recognized agent in that terminal)'
              )}
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {translate(
              'auto.components.sidebar.agent.row.orchestration.action.dialog.cancel',
              'Cancel'
            )}
          </Button>
          <Button
            type="button"
            onClick={() => {
              void submit()
            }}
            disabled={
              submitting ||
              primary.trim().length === 0 ||
              coordinatorPaneKey.length === 0 ||
              Boolean(workerBusyMessage)
            }
          >
            {submitting
              ? translate(
                  'auto.components.sidebar.agent.row.orchestration.action.dialog.working',
                  'Working…'
                )
              : copy.primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
