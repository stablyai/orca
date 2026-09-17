// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'

afterEach(cleanup)

describe('NativeChatApprovalCard', () => {
  it('exposes cancellation while it owns the composer region', () => {
    const onCancel = vi.fn()

    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Allow command?',
          detail: 'pnpm test',
          options: [
            { label: 'Allow', send: 'allow' },
            { label: 'Deny', send: 'deny' }
          ]
        }}
        onChoose={() => {}}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('focuses once on appearance and routes Escape through cancellation', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <NativeChatApprovalCard
        approval={{ title: 'Allow command?', options: [{ label: 'Allow', send: 'allow' }] }}
        onChoose={() => {}}
        onCancel={onCancel}
        shouldFocus
      />
    )
    const card = screen.getByRole('group', { name: 'Allow command?' })

    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    rerender(
      <NativeChatApprovalCard
        approval={{ title: 'Allow command?', options: [{ label: 'Allow', send: 'allow' }] }}
        onChoose={() => {}}
        onCancel={onCancel}
        shouldFocus
      />
    )
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('keeps all oversized provider context in one bounded scroller above the actions', () => {
    const description = `Read access outside the workspace ${'description '.repeat(400)}`
    const decisionReason = `The path is outside the allowed root. ${'reason '.repeat(400)}`
    const blockedPath = `/repo/${'nested/'.repeat(400)}secrets.txt`
    const ruleContent = `/repo/${'**/'.repeat(400)}`
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Claude wants to read secrets.txt '.repeat(400),
          description,
          decisionReason,
          blockedPath,
          matchedAskRule: { source: 'project', toolName: 'Read', ruleContent },
          detail: 'x'.repeat(4_000),
          options: [{ label: 'Allow', send: 'allow' }]
        }}
        onChoose={() => {}}
      />
    )

    const card = document.querySelector('[data-native-chat-approval-card="true"]')
    const content = document.querySelector('[data-native-chat-approval-content="true"]')
    const detail = document.querySelector('[data-native-chat-approval-detail="true"]')
    const actions = document.querySelector('[data-native-chat-approval-actions="true"]')
    const allow = screen.getByRole('button', { name: 'Allow' })

    expect(card?.classList.contains('min-h-0')).toBe(true)
    expect(card?.classList.contains('overflow-hidden')).toBe(true)
    expect(content?.classList.contains('max-h-72')).toBe(true)
    expect(content?.classList.contains('overflow-auto')).toBe(true)
    expect(content?.getAttribute('tabindex')).toBe('0')
    expect(content?.textContent).toContain(description.trim())
    expect(content?.textContent).toContain(decisionReason.trim())
    expect(content?.textContent).toContain(blockedPath)
    expect(content?.textContent).toContain(ruleContent)
    expect(content?.contains(detail)).toBe(true)
    expect(content?.contains(allow)).toBe(false)
    expect(actions?.contains(allow)).toBe(true)
    expect(actions?.classList.contains('shrink-0')).toBe(true)
  })
})
