// @vitest-environment happy-dom
import { fireEvent, render, screen, within, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { SessionLinkCreate } from './SessionLinkCreate'

vi.mock('@/i18n/i18n', () => ({ translate: (_: string, fallback: string) => fallback }))
afterEach(cleanup)
const participant = (sessionId: string, name: string) =>
  SessionLinkParticipant.parse({
    sessionId,
    conversationId: sessionId,
    name,
    agent: 'codex',
    role: 'implementer',
    workspaceId: sessionId,
    directory: `/projects/${sessionId}`,
    branch: 'refs/heads/main',
    task: '',
    context: ''
  })
const source = participant('codex-source', 'Registry implementation')
const partner = participant('codex-partner', 'Architecture review')
describe('SessionLinkCreate from two tabs', () => {
  it('shows the exact pair, swaps their roles and submits their stable session IDs', () => {
    const create = vi.fn()
    render(
      <SessionLinkCreate
        source={source}
        candidates={[participant('codex-other', 'Unrelated chat'), partner]}
        initialPartnerSessionId="codex-partner"
        busy={false}
        onCreate={create}
      />
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    const sourceCard = screen.getByText(source.name).parentElement!
    const partnerCard = screen.getByText(partner.name).parentElement!
    expect(within(sourceCard).getByText('Implements')).toBeTruthy()
    expect(within(partnerCard).getByText('Leads and reviews')).toBeTruthy()
    expect(within(partnerCard).getByText('/projects/codex-partner')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Swap roles' }))
    expect(within(sourceCard).getByText('Leads and reviews')).toBeTruthy()
    expect(within(partnerCard).getByText('Implements')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Checkout slice 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link and introduce agents' }))
    expect(create).toHaveBeenCalledExactlyOnceWith('codex-partner', 'Checkout slice 2', 'reviewer')
  })
  it('refuses a disappeared partner without falling back to a different chat', () => {
    const create = vi.fn()
    render(
      <SessionLinkCreate
        source={source}
        candidates={[participant('codex-other', 'Unrelated chat')]}
        initialPartnerSessionId="codex-partner"
        busy={false}
        onCreate={create}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('no longer available')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Checkout slice 2' } })
    expect(
      screen
        .getByRole('button', { name: 'Create link and introduce agents' })
        .hasAttribute('disabled')
    ).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })
})
