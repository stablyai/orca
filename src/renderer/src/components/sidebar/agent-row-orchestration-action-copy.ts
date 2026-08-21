import { translate } from '@/i18n/i18n'
import type { OrchestrationActionKind } from './agent-row-orchestration-actions'

export function dialogCopy(kind: OrchestrationActionKind): {
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
          'This agent is the worker. Choose which terminal is the coordinator (who owns the task and receives worker_done).'
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
          'Sends a status message to this agent. Choose which terminal is --from (usually your coordinator).'
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
          'Sends a question to this agent. Choose which terminal is --from (usually your coordinator). Wait for the reply with orchestration check --wait.'
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
