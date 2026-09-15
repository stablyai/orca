// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatPlanApprovalCard } from './NativeChatPlanApprovalCard'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

afterEach(cleanup)

const APPROVAL = {
  title: 'Claude wants to present a plan',
  options: [
    { label: 'Approve plan', send: 'allow' },
    { label: 'Keep planning', send: 'deny' }
  ]
}

function PersistentDisclosureHarness(): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  const [mounted, setMounted] = useState(true)
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle mount
      </button>
      {mounted ? (
        <NativeChatPlanApprovalCard
          approval={APPROVAL}
          plan={{ kind: 'plan', text: '# Release\n\n- Keep state' }}
          disclosureKey="approval-1:plan"
          onChoose={() => {}}
        />
      ) : null}
    </NativeChatDisclosureContext.Provider>
  )
}

describe('NativeChatPlanApprovalCard', () => {
  it('renders the typed plan as bounded document markdown', () => {
    render(
      <NativeChatPlanApprovalCard
        approval={APPROVAL}
        plan={{
          kind: 'plan',
          text: '# Release\n\n- **Run tests**\n- Review the [guide](https://example.com)',
          filePath: '/repo/plan.md'
        }}
        disclosureKey="approval-1:plan"
        onChoose={() => {}}
      />
    )

    expect(screen.getByRole('heading', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Run tests').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'guide' })).toBeTruthy()
    expect(screen.getByText('/repo/plan.md')).toBeTruthy()
    const body = document.querySelector('[data-native-chat-plan-body="true"]')
    expect(body?.classList.contains('max-h-72')).toBe(true)
    expect(body?.classList.contains('overflow-auto')).toBe(true)
    expect(body?.getAttribute('tabindex')).toBe('0')
  })

  it('remembers collapse state while the card is unmounted', () => {
    render(<PersistentDisclosureHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse plan' }))
    expect(document.querySelector('[data-native-chat-plan-body="true"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle mount' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle mount' }))

    expect(screen.getByRole('button', { name: 'Expand plan' })).toBeTruthy()
    expect(document.querySelector('[data-native-chat-plan-body="true"]')).toBeNull()
  })
})
