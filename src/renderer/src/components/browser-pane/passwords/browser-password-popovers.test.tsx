// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPasswordSaveButton } from './BrowserPasswordSaveButton'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./browser-password-page-store', () => ({
  useBrowserPasswordPageState: () => ({
    savePrompt: {
      promptId: 'prompt',
      browserPageId: 'page',
      origin: 'https://example.com',
      username: 'ada',
      mode: 'save'
    }
  }),
  clearBrowserPasswordSavePrompt: vi.fn()
}))
afterEach(cleanup)

describe('password save offer visibility', () => {
  it('keeps the pending offer out of inactive panes and closes its portal on deactivation', async () => {
    const view = render(<BrowserPasswordSaveButton browserPageId="page" isActive={false} />)
    await act(async () => {})
    expect(screen.queryByText('Save password?')).toBeNull()
    view.rerender(<BrowserPasswordSaveButton browserPageId="page" isActive />)
    await act(async () => {})
    expect(screen.getByText('Save password?')).toBeDefined()
    view.rerender(<BrowserPasswordSaveButton browserPageId="page" isActive={false} />)
    await act(async () => {})
    expect(screen.queryByText('Save password?')).toBeNull()
  })
})
