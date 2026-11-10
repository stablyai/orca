// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../messages/actions/native-chat-tooltip-test-harness'
import type { OrchestrationCrewRow } from '../../../../../shared/orchestration/orchestration-crew'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'

const rpc = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))

const { NativeChatWorkerApprovalRows, NativeChatWorkerApprovalStrip } =
  await import('./NativeChatWorkerApprovals')

afterEach(() => {
  cleanup()
  rpc.mockClear()
})

const worker: OrchestrationCrewRow = {
  partyKey: 'w',
  role: 'worker',
  label: 'github-install-dialog',
  agentKind: 'claude',
  status: 'blocked'
}

function entry(approvalId: string, extra: Partial<WorkerApprovalPayload> = {}) {
  return {
    approval: {
      v: 1 as const,
      approvalId,
      state: 'open' as const,
      worker: { handle: 'term_w', dispatchId: 'ctx_1', taskId: 'task_1' },
      summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
      allowedActions: ['allow' as const, 'deny' as const],
      ...extra
    },
    at: '2026-11-10T20:41:00.000Z',
    worker
  }
}

const target = { kind: 'local' } as const

describe('worker approval cards', () => {
  it("answers Allow on the worker's own prompt, with no reason", () => {
    render(<NativeChatWorkerApprovalRows approvals={[entry('apr_1')]} target={target} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(rpc).toHaveBeenLastCalledWith(target, 'orchestration.approvalAnswer', {
      dispatch: 'ctx_1',
      prompt: 'apr_1',
      decision: 'allow'
    })
  })

  it("denies with the owner's fixed reason, and offers no Cancel that would stop the chat's own turn", () => {
    render(<NativeChatWorkerApprovalRows approvals={[entry('apr_1')]} target={target} />)

    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(rpc).toHaveBeenLastCalledWith(target, 'orchestration.approvalAnswer', {
      dispatch: 'ctx_1',
      prompt: 'apr_1',
      decision: 'deny',
      reason: 'Denied by the owner.'
    })
  })

  it('shows a closed approval as a receipt with no answer buttons', () => {
    render(
      <NativeChatWorkerApprovalRows
        approvals={[
          entry('apr_1', {
            state: 'answered',
            allowedActions: [],
            outcome: { by: 'person', decision: 'allow', reason: null, reasonDelivered: true }
          })
        ]}
        target={target}
      />
    )
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })
})

describe('worker approval strip', () => {
  it('counts open approvals only, and Show scrolls to the oldest open card', () => {
    const scrolled = vi.fn()
    const root = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('data-native-chat-worker-approval', 'apr_old')
    card.scrollIntoView = scrolled
    root.append(card)
    const closed = entry('apr_done', {
      state: 'answered',
      allowedActions: [],
      outcome: { by: 'person', decision: 'deny', reason: null, reasonDelivered: true }
    })

    render(
      <NativeChatWorkerApprovalStrip
        approvals={[closed, entry('apr_old'), entry('apr_new')]}
        rootRef={{ current: root }}
      />
    )
    expect(screen.getByText('2 approvals')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('is absent when no approval is open', () => {
    const { container } = render(
      <NativeChatWorkerApprovalStrip approvals={[]} rootRef={{ current: null }} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('when an open card stops being shown', () => {
  it('lapses only an open card whose countdown passed, after a grace for its closing message', async () => {
    const { workerApprovalLapsesAt } = await import('./worker-approval-card-model')
    const expiresAt = '2026-11-10T20:43:00.000Z'
    expect(workerApprovalLapsesAt(entry('a', { expiresAt }).approval)).toBe(
      Date.parse('2026-11-10T20:43:15.000Z')
    )
    expect(workerApprovalLapsesAt(entry('b').approval)).toBe(Number.POSITIVE_INFINITY)
    expect(workerApprovalLapsesAt(entry('c', { expiresAt, state: 'answered' }).approval)).toBe(
      Number.POSITIVE_INFINITY
    )
  })
})
