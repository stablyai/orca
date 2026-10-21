// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params?.[name] ?? '')
}))

const { UnsealedCredentialNotice } = await import('./UnsealedCredentialNotice')

describe('UnsealedCredentialNotice', () => {
  afterEach(cleanup)

  it('warns when the stored credential is plaintext', () => {
    render(<UnsealedCredentialNotice protection="plaintext" credentialName="MiniMax API key" />)
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('MiniMax API key is stored unencrypted')
    // The remedy has to be in the message; the console warning it replaces had none.
    expect(text).toMatch(/gnome-keyring|kwallet/)
  })

  it('renders nothing when the credential is sealed', () => {
    render(<UnsealedCredentialNotice protection="sealed" credentialName="MiniMax API key" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Why null must stay silent: it means "nothing stored" or "envelope unreadable", and
  // warning that an absent credential is exposed would be worse than saying nothing.
  it('renders nothing when protection is unknown', () => {
    render(<UnsealedCredentialNotice protection={null} credentialName="MiniMax API key" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the credential so a pane with several is unambiguous', () => {
    render(
      <UnsealedCredentialNotice protection="plaintext" credentialName="MiniMax Session Cookie" />
    )
    expect(screen.getByRole('alert').textContent).toContain('MiniMax Session Cookie')
  })
})
