// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLink, SessionLinkEvent } from '../../../../shared/session-link'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SessionLinkOwnerDecision } from './SessionLinkOwnerDecision'
const link = SessionLink.parse({
  id: 'pair',
  story: 'Keep protected data local',
  state: 'paused',
  reason: 'owner-decision',
  version: 2,
  turns: 3,
  messages: 4,
  createdAt: 1,
  updatedAt: 2,
  participants: [
    {
      sessionId: 'claude_review',
      conversationId: 'claude_review',
      name: 'Truncated chat...',
      agent: 'claude',
      workspaceId: 'review',
      directory: '/review',
      branch: 'main',
      task: 'Review',
      context: '',
      role: 'reviewer'
    },
    {
      sessionId: 'codex_implement',
      conversationId: 'codex_implement',
      name: 'Truncated implementation...',
      agent: 'codex',
      workspaceId: 'implementation',
      directory: '/implementation',
      branch: 'feature',
      task: 'Implement',
      context: '',
      role: 'implementer'
    }
  ]
})
const request = SessionLinkEvent.parse({
  id: 'question',
  linkId: link.id,
  actor: 'claude_review',
  recipient: null,
  kind: 'owner-request',
  messageId: null,
  replyTo: null,
  state: 'recorded',
  operationId: 'ask',
  createdAt: 1,
  detail: '',
  body: 'Approve verification up to $0.10?',
  choices: [
    { label: 'Approve $0.10' },
    { label: 'Continue offline only' },
    { label: 'Stop for review' }
  ]
})
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})
function render(
  event: SessionLinkEvent,
  onAnswer: (body: string) => Promise<boolean>,
  disabled = false
) {
  act(() =>
    root.render(
      <TooltipProvider>
        <SessionLinkOwnerDecision
          request={event}
          link={link}
          disabled={disabled}
          atomic
          onAnswer={onAnswer}
        />
      </TooltipProvider>
    )
  )
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}
function type(value: string) {
  const field = container.querySelector('textarea')
  if (!field) {
    throw new Error('Missing free-text answer')
  }
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('session-link owner decision', () => {
  it('shows choices as buttons and sends the selected label once', async () => {
    const onAnswer = vi.fn().mockResolvedValue(true)
    render(request, onAnswer)
    expect(container.textContent).toContain('Claude asks you')
    expect(container.textContent).toContain('Claude (reviewer) ↔ Codex (implementer)')
    expect(container.textContent).not.toContain('Truncated')
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(3)
    act(() => button('Continue offline only').click())
    await act(async () => button('Answer and continue').click())
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('Continue offline only')
  })
  it('keeps a legacy no-choices question answerable with free text', async () => {
    const onAnswer = vi.fn().mockResolvedValue(true)
    render({ ...request, choices: undefined }, onAnswer)
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    expect(button('Answer and continue').disabled).toBe(true)
    type('Continue offline. No spending approved.')
    await act(async () => button('Answer and continue').click())
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('Continue offline. No spending approved.')
  })
  it('hides free text when disallowed and refuses answers while delivery is unresolved', () => {
    const onAnswer = vi.fn().mockResolvedValue(true)
    render({ ...request, allowOther: false }, onAnswer, true)
    expect(container.querySelector('textarea')).toBeNull()
    act(() => button('Approve $0.10').click())
    expect(button('Answer and continue').disabled).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
  })
  it('offers only collapse, preserves a draft and never treats collapse as an answer', () => {
    const onAnswer = vi.fn().mockResolvedValue(true)
    render(request, onAnswer)
    expect(container.querySelector('button[aria-label="Cancel"]')).toBeNull()
    type('Keep working offline.')
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')
    act(() => collapse?.click())
    expect(container.querySelector('[data-native-chat-prompt-strip]')).not.toBeNull()
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')
    act(() => expand?.click())
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(3)
    expect(container.querySelector('textarea')?.value).toBe('Keep working offline.')
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
