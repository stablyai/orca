/**
 * Agent-to-Agent Message Consent Dialog (P1-2)
 *
 * Reusable UI primitive: asks the user whether `sourceAgentType` may send
 * cross-session messages (via the P0-2 broker, src/main/runtime/agent-message-broker.ts)
 * to `targetAgentType`, and records the answer through P1-1's
 * `agent.consent.record` RPC method (src/main/runtime/rpc/methods/agent-consent.ts).
 *
 * Deliberately mirrors PluginConsentDialog's shape
 * (src/renderer/src/components/settings/PluginConsentDialog.tsx) — the same
 * kind of decision (a trust boundary the user must explicitly cross), so it
 * gets the same visual language: title, plain-language description of what
 * is being requested, a safe-default dismiss action, and an explicit accept
 * action, both wired through one `decide()` helper that tracks per-decision
 * busy state and surfaces failures inline instead of swallowing them.
 *
 * Placement: src/renderer/src/components/agent/ rather than .../settings/ —
 * this dialog is not a Settings-pane artifact (nothing here reads or writes
 * GlobalSettings, and there is no Settings row that opens it). It belongs
 * next to this directory's other agent-identity dialogs that are launched
 * from outside Settings (AgentSettingsDialog.tsx, AgentCombobox.tsx),
 * addressing agentType identity the same way P0-1/P0-2/P1-1 do.
 *
 * Scope note: this component only renders/decides an already-pending
 * request; nothing in this codebase yet originates a cross-session message
 * for it to respond to (the native-chat @ mention only addresses files
 * today). Deciding *when* this dialog should appear is a future phase's
 * job — see the P1-2 task's scope boundary.
 */

import { useRef, useState } from 'react'
import { AlertTriangle, Loader2, MessageCircleQuestion } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentConsentDecision, AgentConsentRecord } from '../../../../shared/agent-consent'

export type AgentConsentDialogProps = {
  /** Whether the dialog is currently open. */
  open: boolean
  /** agentType of the agent that would be sending the message (P0-1's
   *  stable per-agent-type identity, e.g. "codex", "pi" — NOT a per-session
   *  keyId; see src/shared/agent-consent.ts for why). */
  sourceAgentType: string
  /** agentType of the agent that would receive the message. */
  targetAgentType: string
  /** Closes the dialog. Called both after a decision is successfully
   *  recorded, and when the user dismisses without pressing Allow/Deny
   *  (Escape, overlay click) — dismissal itself is treated as an explicit
   *  Deny (see decide() below), so this always follows an onDecision call
   *  when the dialog had a request to decide. */
  onOpenChange: (open: boolean) => void
  /** Called after `agent.consent.record` succeeds, with the decision that
   *  was recorded and the full persisted record the RPC returned. */
  onDecision?: (decision: AgentConsentDecision, record: AgentConsentRecord) => void
}

function agentConsentErrorMessage(cause: unknown): string {
  if (cause instanceof RuntimeRpcCallError) {
    return cause.message || genericAgentConsentError()
  }
  return genericAgentConsentError()
}

function genericAgentConsentError(): string {
  return translate(
    'auto.components.agent.AgentConsentDialog.decisionFailed',
    'Could not save this decision. Try again.'
  )
}

export function AgentConsentDialog({
  open,
  sourceAgentType,
  targetAgentType,
  onOpenChange,
  onDecision
}: AgentConsentDialogProps): React.JSX.Element {
  // Why: freeze the pair being reviewed for the lifetime of one open dialog —
  // mirrors PluginConsentDialog's `useRef(currentPlugin).current` guard so a
  // prop change mid-review can never silently retarget which pair the
  // in-flight decision applies to.
  const reviewedPairRef = useRef({ sourceAgentType, targetAgentType })
  if (!open) {
    reviewedPairRef.current = { sourceAgentType, targetAgentType }
  }
  const { sourceAgentType: reviewedSource, targetAgentType: reviewedTarget } =
    reviewedPairRef.current
  const denyRef = useRef<HTMLButtonElement>(null)
  const [busyDecision, setBusyDecision] = useState<AgentConsentDecision | null>(null)
  const [error, setError] = useState<string | null>(null)

  const decide = async (decision: AgentConsentDecision): Promise<void> => {
    if (busyDecision) {
      return
    }
    setBusyDecision(decision)
    setError(null)
    try {
      const record = await callRuntimeRpc<AgentConsentRecord>(
        { kind: 'local' },
        'agent.consent.record',
        {
          sourceAgentType: reviewedSource,
          targetAgentType: reviewedTarget,
          decision
        }
      )
      onDecision?.(decision, record)
      onOpenChange(false)
    } catch (cause) {
      console.warn('[agent-consent] failed to record decision:', cause)
      setError(agentConsentErrorMessage(cause))
    } finally {
      setBusyDecision(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          // Why: deny-by-default already covers "never decided" (see
          // gateAgentMessageSend in src/shared/agent-consent-gate.ts), but a
          // visible dismissal should still persist as an explicit decision —
          // same reasoning PluginConsentDialog applies to its own dismiss.
          void decide('deny')
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Why: dismissal/deny is the safety-preserving path, so it gets initial focus.
          event.preventDefault()
          denyRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.agent.AgentConsentDialog.title', 'Allow agent messaging?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.agent.AgentConsentDialog.description',
              '{{source}} wants permission to send messages to {{target}} agents across sessions.',
              { source: reviewedSource, target: reviewedTarget }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
          <MessageCircleQuestion className="mt-1 size-4 shrink-0" />
          <span>
            {translate(
              'auto.components.agent.AgentConsentDialog.explanation',
              'Allowing this lets any "{{source}}" session send messages to any "{{target}}" session running on this machine. You can change this later.',
              { source: reviewedSource, target: reviewedTarget }
            )}
          </span>
        </div>
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            ref={denyRef}
            variant="ghost"
            size="sm"
            disabled={Boolean(busyDecision)}
            onClick={() => void decide('deny')}
          >
            {busyDecision === 'deny' ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.agent.AgentConsentDialog.deny', 'Deny')}
          </Button>
          <Button size="sm" disabled={Boolean(busyDecision)} onClick={() => void decide('allow')}>
            {busyDecision === 'allow' ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.agent.AgentConsentDialog.allow', 'Allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
