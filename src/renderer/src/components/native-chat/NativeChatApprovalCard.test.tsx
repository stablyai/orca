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

  it('renders provider context and keeps oversized generic detail in a bounded scroller', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Claude wants to read secrets.txt',
          description: 'Read access outside the workspace',
          decisionReason: 'The path is outside the allowed root.',
          blockedPath: '/repo/secrets.txt',
          matchedAskRule: { source: 'project', toolName: 'Read', ruleContent: '/repo/**' },
          detail: 'x'.repeat(4_000),
          options: [{ label: 'Allow', send: 'allow' }]
        }}
        onChoose={() => {}}
      />
    )

    expect(screen.getByText('Read access outside the workspace')).toBeTruthy()
    expect(screen.getByText(/The path is outside the allowed root/)).toBeTruthy()
    expect(screen.getByText('/repo/secrets.txt')).toBeTruthy()
    expect(screen.getByText(/\/repo\/\*\*/)).toBeTruthy()
    const detail = document.querySelector('[data-native-chat-approval-detail="true"]')
    expect(detail?.classList.contains('max-h-72')).toBe(true)
    expect(detail?.classList.contains('overflow-auto')).toBe(true)
    expect(detail?.getAttribute('tabindex')).toBe('0')
  })
})
