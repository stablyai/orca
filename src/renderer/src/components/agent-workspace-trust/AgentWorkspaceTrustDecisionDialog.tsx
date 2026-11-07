import { useEffect, useState, useSyncExternalStore } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentWorkspaceTrustDecision } from '../../../../shared/agent-workspace-trust-decision'
import { agentWorkspaceTrustDecisionCopy as copy } from './agent-workspace-trust-decision-copy'
import {
  answerAgentWorkspaceTrustDecision,
  getAgentWorkspaceTrustDecisionRequest,
  subscribeAgentWorkspaceTrustDecisionRequest
} from './agent-workspace-trust-decision-prompt'

export type AgentWorkspaceTrustDecisionDialogViewProps = {
  repoName: string
  saving: boolean
  onAnswer: (decision: AgentWorkspaceTrustDecision) => void
}

/** A launch waits on this answer, so it closes only through a choice. */
export function AgentWorkspaceTrustDecisionDialogView({
  repoName,
  saving,
  onAnswer
}: AgentWorkspaceTrustDecisionDialogViewProps): React.JSX.Element {
  return (
    <DialogContent
      className="sm:max-w-md"
      showCloseButton={false}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle size="compact">
          <span className="flex items-center gap-2">
            <ShieldQuestion className="size-4 text-muted-foreground" aria-hidden="true" />
            {copy.promptTitle(repoName)}
          </span>
        </DialogTitle>
        <DialogDescription>{copy.promptDescription()}</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">{copy.promptRemembered()}</p>
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => onAnswer('agent-asks')}
        >
          {copy.letAgentsAsk()}
        </Button>
        <Button
          type="button"
          size="sm"
          autoFocus
          disabled={saving}
          onClick={() => onAnswer('pre-trust')}
        >
          {copy.trustRepository()}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export default function AgentWorkspaceTrustDecisionDialog(): React.JSX.Element | null {
  const request = useSyncExternalStore(
    subscribeAgentWorkspaceTrustDecisionRequest,
    getAgentWorkspaceTrustDecisionRequest,
    getAgentWorkspaceTrustDecisionRequest
  )
  const [savingFor, setSavingFor] = useState<typeof request>(null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const open = request !== null
  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(open)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [open, setContextualToursBlockingSurfaceVisible])
  if (!request) {
    return null
  }
  const answer = (decision: AgentWorkspaceTrustDecision): void => {
    setSavingFor(request)
    void answerAgentWorkspaceTrustDecision(decision).finally(() => setSavingFor(null))
  }
  return (
    <Dialog open>
      <AgentWorkspaceTrustDecisionDialogView
        key={`${request.hostId}:${request.repoId}`}
        repoName={request.repoName}
        saving={savingFor === request}
        onAnswer={answer}
      />
    </Dialog>
  )
}
