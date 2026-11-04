import { toast } from 'sonner'
import { workflowRpc } from './workflow-rpc'
import { refreshWorkflowRun, useWorkflowRunViewStore } from './workflow-run-view-store'
import { translate } from '@/i18n/i18n'

async function onRun(
  label: string,
  action: (target: NonNullable<ReturnType<typeof current>>) => Promise<unknown>
): Promise<boolean> {
  const target = current()
  if (!target) {
    return false
  }
  try {
    await action(target)
    refreshWorkflowRun()
    return true
  } catch (error) {
    toast.error(
      translate('auto.components.workflows.workflow.run.actions.93121a71d7', '{{value0}} failed', {
        value0: label
      }),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
    return false
  }
}

function current() {
  const { target, runId } = useWorkflowRunViewStore.getState()
  return target && runId ? { target, runId } : null
}

/** Run controls; each re-polls afterwards so the view shows what the host actually did. */
export const workflowRunActions = {
  pause: () => onRun('Pause', ({ target, runId }) => workflowRpc.pause(target, runId)),
  resume: () => onRun('Resume', ({ target, runId }) => workflowRpc.resume(target, runId)),
  cancel: () => onRun('Cancel', ({ target, runId }) => workflowRpc.cancel(target, runId)),
  retry: (taskKey: string) =>
    onRun('Retry', ({ target, runId }) => workflowRpc.retryTask(target, runId, taskKey)),
  resolveApproval: (taskKey: string, resolution: 'approved' | 'rejected') =>
    onRun('Approval', ({ target, runId }) =>
      workflowRpc.resolveApproval(target, runId, taskKey, resolution)
    ),
  releaseMessage: (messageId: string, decision: 'deliver' | 'drop') =>
    onRun('Release', ({ target, runId }) =>
      workflowRpc.releaseMessage(target, runId, messageId, decision)
    ),
  reply: (messageId: string, body: string) =>
    onRun('Reply', ({ target, runId }) =>
      workflowRpc.replyToQuestion(target, runId, messageId, body)
    )
}
