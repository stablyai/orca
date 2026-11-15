// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredAgentSessionHostSupport from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { AGENT_SESSION_APPROVAL_FEEDBACK_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StructuredAgentSessionAction } from '../session/structured/writes/use-structured-agent-session-mutate'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { respondToStructuredAgentSessionPrompt } from './structured-agent-session-prompt-response'

const hostSupport = vi.hoisted(() => ({
  supportsFeedback: vi.fn(async () => true)
}))

vi.mock(
  '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StructuredAgentSessionHostSupport>()
    return {
      ...actual,
      supportsStructuredAgentSessionApprovalFeedback: hostSupport.supportsFeedback
    }
  }
)

afterEach(() => {
  cleanup()
  hostSupport.supportsFeedback.mockReset().mockResolvedValue(true)
})

function planApproval(overrides: Partial<ChatApproval> = {}): ChatApproval {
  return {
    title: 'Review proposed plan',
    subject: { kind: 'plan', text: '1. Update schema', filePath: '/workspace/plan.md' },
    options: [
      { label: 'Approve and auto-accept edits', send: 'allowAcceptEdits', intent: 'allow_always' },
      { label: 'Approve and ask before edits', send: 'allow', intent: 'allow_once' },
      { label: 'Keep planning', send: 'deny', intent: 'reject_once' }
    ],
    freeTextInput: { multiline: true },
    ...overrides
  }
}

describe('NativeChatApprovalCard plan review', () => {
  it('submits A/B/C options by click or digit key and submits trimmed feedback without losing drafts on Escape', () => {
    const onChoose = vi.fn()
    const onCancel = vi.fn()
    render(
      <NativeChatApprovalCard
        approval={planApproval()}
        onChoose={onChoose}
        onCancel={onCancel}
        shouldFocus
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve and auto-accept edits' }))
    expect(onChoose).toHaveBeenLastCalledWith('allowAcceptEdits')

    fireEvent.keyDown(document.body, { key: '2' })
    expect(onChoose).toHaveBeenLastCalledWith('allow')

    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()

    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: '   ' } })
    expect(submit).toBeDisabled()

    fireEvent.change(field, { target: { value: '  Split migration step  ' } })
    expect(submit).toBeEnabled()

    // Escape inside the revision field must not cancel or dismiss the card.
    fireEvent.focus(field)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(submit)
    expect(onChoose).toHaveBeenLastCalledWith('deny', 'Split migration step')
  })

  it('navigates between option buttons and the revision textarea with ArrowUp/ArrowDown and submits via Cmd/Ctrl+Enter', () => {
    const onChoose = vi.fn()
    render(<NativeChatApprovalCard approval={planApproval()} onChoose={onChoose} shouldFocus />)

    const buttons = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('data-native-chat-approval-option'))
    const field = screen.getByRole('textbox')
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error('Expected textarea textbox')
    }
    fireEvent.change(field, { target: { value: 'line1\nline2' } })

    act(() => buttons[2]!.focus())
    fireEvent.keyDown(buttons[2]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(field)

    field.setSelectionRange(0, 0)
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(buttons[2])

    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
    expect(onChoose).toHaveBeenCalledWith('deny', 'line1\nline2')
  })

  it('gates approval feedback RPCs on the runtime capability', async () => {
    const mutateCalls: unknown[][] = []
    const mutate: StructuredAgentSessionAction['mutate'] = async (...args) => {
      mutateCalls.push(args)
      return null
    }
    const action: StructuredAgentSessionAction = {
      target: { kind: 'local' },
      write: vi.fn(),
      mutate
    }
    const item = {
      itemId: 'item-1',
      sequence: 1,
      revision: 3,
      observedAt: 1,
      body: {
        kind: 'approval' as const,
        title: 'Review proposed plan',
        detail: null,
        subject: { kind: 'plan' as const, text: 'Plan' },
        options: [
          { id: 'allow', label: 'Approve plan', intent: 'allow_once' as const },
          { id: 'deny', label: 'Keep planning', intent: 'reject_once' as const }
        ],
        freeTextInput: { multiline: true },
        resolution: {
          state: 'pending' as const,
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      }
    }

    hostSupport.supportsFeedback.mockResolvedValueOnce(false)
    expect(
      await respondToStructuredAgentSessionPrompt({
        item,
        response: { kind: 'option', optionId: 'deny', feedback: 'Revise step 2' },
        action
      })
    ).toBeNull()
    expect(mutateCalls).toEqual([])

    await respondToStructuredAgentSessionPrompt({
      item,
      response: { kind: 'option', optionId: 'deny', feedback: 'Revise step 2' },
      action
    })
    expect(AGENT_SESSION_APPROVAL_FEEDBACK_RUNTIME_CAPABILITY).toBe(
      'agent-session.approval-feedback.v1'
    )
    expect(mutateCalls).toEqual([
      [
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        {
          itemId: 'item-1',
          expectedRevision: 3,
          optionId: 'deny',
          feedback: 'Revise step 2'
        }
      ]
    ])
  })

  it('includes revision feedback alongside the selected approval option label in the resolution receipt', () => {
    render(
      <TooltipProvider>
        <NativeChatResolutionReceipt
          body={{
            kind: 'approval',
            title: 'Review proposed plan',
            detail: null,
            subject: { kind: 'plan', text: 'Plan text' },
            options: [
              { id: 'allow', label: 'Approve plan', intent: 'allow_once' },
              { id: 'deny', label: 'Keep planning', intent: 'reject_once' }
            ],
            freeTextInput: { multiline: true },
            resolution: {
              state: 'resolved',
              selectedOptionId: 'deny',
              feedback: 'Make step 2 atomic',
              resolvedBy: null,
              resolvedAt: 1000
            }
          }}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Keep planning · Make step 2 atomic')).toBeInTheDocument()
  })
})
