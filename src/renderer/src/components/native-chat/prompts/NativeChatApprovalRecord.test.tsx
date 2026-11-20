// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  WorkerApprovalOutcome,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { workerApprovalRecordLine } from '../worker-approvals/worker-approval-card-model'
import { NativeChatApprovalRecord } from './NativeChatApprovalRecord'
import {
  ownApprovalRecordLine,
  type NativeChatApprovalRecordLine
} from './native-chat-approval-record'

afterEach(cleanup)

const AT = '2026-11-18T18:12:00.000Z'

function workerApproval(
  outcome: WorkerApprovalOutcome,
  summary: Partial<WorkerApprovalPayload['summary']> = {}
): WorkerApprovalPayload {
  return {
    v: 1,
    approvalId: 'apr_1',
    state: 'answered',
    worker: { handle: 'term_1', dispatchId: 'ctx_1', taskId: 'task_1' },
    summary: {
      title: 'Allow Bash?',
      tool: 'Bash',
      detail: '{"command":"ls -la"}',
      reason: null,
      ...summary
    },
    allowedActions: [],
    outcome
  }
}

function ownApproval(
  selectedOptionId: string | null,
  resolvedBy: string | null = null
): AgentJournalApprovalItem {
  return {
    kind: 'approval',
    title: 'Run a command?',
    detail: 'git push',
    options: [
      { id: 'accept', label: 'Allow', intent: 'allow_once' },
      { id: 'acceptForSession', label: 'Allow for this session', intent: 'allow_always' },
      { id: 'decline', label: 'Deny', intent: 'reject_once' },
      { id: 'cancel', label: 'Stop' }
    ],
    resolution: {
      state: selectedOptionId ? 'resolved' : 'cancelled',
      selectedOptionId,
      resolvedBy,
      resolvedAt: Date.parse(AT)
    }
  }
}

function show(line: NativeChatApprovalRecordLine, onOpenWorker?: () => void): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <NativeChatApprovalRecord line={line} onOpenWorker={onOpenWorker} />
    </TooltipProvider>
  )
  return container.querySelector<HTMLElement>('[data-native-chat-approval-record]')!
}

describe('NativeChatApprovalRecord', () => {
  it('reads a worker-chat answer by its decision', () => {
    const record = show(
      workerApprovalRecordLine(
        workerApproval({
          by: 'worker-chat',
          decision: 'deny',
          reason: null,
          reasonDelivered: false
        }),
        'docs-copy-pass',
        AT,
        translate
      )
    )
    expect(record).toHaveAttribute('data-native-chat-approval-record', 'denied')
    expect(record).toHaveTextContent('Bash')
    expect(record).toHaveTextContent('docs-copy-pass')
  })

  it("uses the prompt title and opens the coordinator's allow reason and command", () => {
    const record = show(
      workerApprovalRecordLine(
        workerApproval(
          {
            by: 'coordinator',
            decision: 'allow',
            reason: 'Read-only listing.',
            reasonDelivered: true
          },
          { title: 'Run a read-only command?', tool: undefined }
        ),
        'github-install-dialog',
        AT,
        translate
      )
    )
    expect(record).toHaveAttribute('data-native-chat-approval-record', 'allowed')
    expect(record).toHaveTextContent('Run a read-only command?')
    expect(screen.queryByText('Read-only listing.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('Read-only listing.')).toBeInTheDocument()
    expect(screen.getByText('ls -la')).toBeInTheDocument()
  })

  it("reads the chat's own prompt by the picked option's intent", () => {
    expect(show(ownApprovalRecordLine(ownApproval('acceptForSession'), translate))).toHaveAttribute(
      'data-native-chat-approval-record',
      'allowed'
    )
    cleanup()
    const stopped = show(ownApprovalRecordLine(ownApproval('cancel'), translate))
    expect(stopped).toHaveAttribute('data-native-chat-approval-record', 'closed')
    expect(stopped).toHaveTextContent('Stop')
    cleanup()
    expect(show(ownApprovalRecordLine(ownApproval(null), translate))).toHaveAttribute(
      'data-native-chat-approval-record',
      'closed'
    )
  })

  it("names who answered a worker's prompt in its own chat: coordinator, person, or no one on older rows", () => {
    const reads = (optionId: string, resolvedBy: string): HTMLElement =>
      show(ownApprovalRecordLine(ownApproval(optionId, resolvedBy), translate))
    expect(
      reads('decline', 'trusted-local:orchestration:approval:coordinator:ctx_1')
    ).toHaveTextContent('Coordinator denied')
    cleanup()
    expect(reads('accept', 'trusted-local:orchestration:approval:person:ctx_1')).toHaveTextContent(
      'You allowed'
    )
    cleanup()
    const legacy = reads('accept', 'trusted-local:orchestration:approval:ctx_1')
    expect(legacy).toHaveTextContent(/^Allowed Run a command\?/)
    expect(legacy).toHaveAttribute('data-native-chat-approval-record', 'allowed')
  })

  it('opens the worker from its task and from a prompt left in its terminal', () => {
    const onOpenWorker = vi.fn()
    show(
      workerApprovalRecordLine(
        workerApproval({
          by: 'terminal-only',
          decision: null,
          reason: null,
          reasonDelivered: false
        }),
        'docs-copy-pass',
        AT,
        translate
      ),
      onOpenWorker
    )
    fireEvent.click(screen.getByRole('button', { name: 'docs-copy-pass' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open worker' }))
    expect(onOpenWorker).toHaveBeenCalledTimes(2)
  })
})
