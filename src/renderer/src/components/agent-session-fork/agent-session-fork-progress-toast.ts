import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentSessionForkStage } from '@/lib/agent-session-fork-flow'

/** `preparing` covers the wait for the parent's status, before anything is created. */
export type AgentSessionForkDialogStage = AgentSessionForkStage | 'preparing'

export function agentSessionForkStageLabel(stage: AgentSessionForkDialogStage): string {
  switch (stage) {
    case 'preparing':
      return translate('components.agentSessionFork.stage.preparing', 'Preparing…')
    case 'creating':
      return translate('components.agentSessionFork.stage.creating', 'Creating workspace…')
    case 'carrying':
      return translate('components.agentSessionFork.stage.carrying', 'Copying changes…')
    case 'launching':
      return translate('components.agentSessionFork.stage.launching', 'Starting agent…')
  }
}

export type AgentSessionForkProgressToast = {
  stage: (stage: AgentSessionForkDialogStage) => void
  succeed: () => void
  fail: (error: string) => void
}

/** Mirrors fork stages in a loading toast once the dialog that showed them is gone. */
export function createAgentSessionForkProgressToast(
  isDialogShown: () => boolean
): AgentSessionForkProgressToast {
  let toastId: string | number | null = null
  return {
    stage(stage) {
      if (toastId !== null) {
        toast.loading(agentSessionForkStageLabel(stage), { id: toastId })
      } else if (!isDialogShown()) {
        toastId = toast.loading(agentSessionForkStageLabel(stage))
      }
    },
    succeed() {
      if (toastId !== null) {
        toast.dismiss(toastId)
      }
    },
    fail(error) {
      if (toastId !== null) {
        toast.error(error, { id: toastId })
      } else {
        toast.error(error)
      }
    }
  }
}
