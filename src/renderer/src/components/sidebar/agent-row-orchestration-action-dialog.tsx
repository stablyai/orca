import React, { useEffect, useMemo, useState } from 'react'
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
  getActiveTerminalPaneKey,
  sendMessageToAgent,
  type OrchestrationActionKind
} from './agent-row-orchestration-actions'
import type { AgentRowOrchestrationTarget } from './worktree-agent-orchestration-menu'

export type AgentRowOrchestrationActionDialogState = {
  kind: OrchestrationActionKind
  target: AgentRowOrchestrationTarget
}

type Props = {
  state: AgentRowOrchestrationActionDialogState | null
  onOpenChange: (open: boolean) => void
}

function dialogCopy(kind: OrchestrationActionKind): {
  title: string
  description: string
  primaryLabel: string
  primaryFieldLabel: string
  primaryPlaceholder: string
} {
  switch (kind) {
    case 'dispatch':
      return {
        title: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.title',
          'Dispatch to this agent'
        ),
        description: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.description',
          'Creates an orchestration task and dispatches it to this agent. The focused terminal is the coordinator.'
        ),
        primaryLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.submit',
          'Dispatch'
        ),
        primaryFieldLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.spec',
          'Task spec'
        ),
        primaryPlaceholder: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.dispatch.placeholder',
          'e.g. Fix the login button CSS and add a regression test'
        )
      }
    case 'send':
      return {
        title: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.send.title',
          'Send message to this agent'
        ),
        description: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.send.description',
          'Sends an orchestration status message. The focused terminal is used as --from.'
        ),
        primaryLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.send.submit',
          'Send'
        ),
        primaryFieldLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.send.subject',
          'Subject'
        ),
        primaryPlaceholder: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.send.placeholder',
          'e.g. Please review auth changes'
        )
      }
    case 'ask':
      return {
        title: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.title',
          'Ask this agent'
        ),
        description: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.description',
          'Sends a blocking ask to this agent and waits up to 2 minutes for a reply. Focused terminal is the coordinator.'
        ),
        primaryLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.submit',
          'Ask'
        ),
        primaryFieldLabel: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.question',
          'Question'
        ),
        primaryPlaceholder: translate(
          'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.placeholder',
          'e.g. Which hashing algorithm should we use?'
        )
      }
  }
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

  useEffect(() => {
    if (open) {
      setPrimary('')
      setBody('')
      setInject(true)
      setSubmitting(false)
    }
  }, [open, kind, target?.paneKey])

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
    setSubmitting(true)
    try {
      const store = useAppStore.getState()
      const coordinatorPaneKey = getActiveTerminalPaneKey(store)
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
          )
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
        if (result.timedOut || !result.answer) {
          toast.error(
            translate(
              'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.timeout',
              'No reply from {{handle}} within 2 minutes',
              { handle: result.workerHandle }
            )
          )
        } else {
          toast.success(
            translate(
              'auto.components.sidebar.agent.row.orchestration.action.dialog.ask.success',
              'Answer from {{handle}}: {{answer}}',
              { handle: result.workerHandle, answer: result.answer }
            )
          )
        }
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
            disabled={submitting || primary.trim().length === 0}
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
