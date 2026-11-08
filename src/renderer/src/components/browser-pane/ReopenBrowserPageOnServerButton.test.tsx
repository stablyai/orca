// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reopenMocks = vi.hoisted(() => ({ reopenBrowserPageOnServer: vi.fn() }))

vi.mock('./browser-reopen-on-server', () => ({
  reopenBrowserPageOnServer: reopenMocks.reopenBrowserPageOnServer
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { ReopenBrowserPageOnServerButton } from './ReopenBrowserPageOnServerButton'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function renderButton(): HTMLElement {
  render(
    <ReopenBrowserPageOnServerButton
      environmentId="environment-a"
      worktreeId="worktree-a"
      lastCommittedUrl="https://example.internal/report"
    />
  )
  return screen.getByRole('button')
}

describe('ReopenBrowserPageOnServerButton', () => {
  it('rejects a second click while the first is still running', () => {
    reopenMocks.reopenBrowserPageOnServer.mockImplementation(() => new Promise<boolean>(() => {}))
    const button = renderButton()

    fireEvent.click(button)
    fireEvent.click(button)

    expect(reopenMocks.reopenBrowserPageOnServer).toHaveBeenCalledTimes(1)
  })
})
