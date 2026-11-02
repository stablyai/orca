// @vitest-environment happy-dom
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraConnectionStatus } from '../../../shared/jira-types'
import { JiraConnectDialog } from './jira-connect-dialog'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'

type FixtureState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  jiraStatus: JiraConnectionStatus
  jiraStatusContextKey: string | null
}

const mocks = vi.hoisted(() => {
  const state: FixtureState = {
    settings: { activeRuntimeEnvironmentId: null },
    jiraStatus: { connected: false, viewer: null },
    jiraStatusContextKey: null
  }
  return {
    connectJira: vi.fn(),
    state
  }
})
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: typeof mocks.state & { connectJira: typeof mocks.connectJira }) => unknown
  ) => selector({ ...mocks.state, connectJira: mocks.connectJira })
}))

beforeEach(() => {
  mocks.connectJira.mockReset().mockResolvedValue({ ok: true })
  mocks.state.settings.activeRuntimeEnvironmentId = null
  mocks.state.jiraStatus = { connected: false, viewer: null }
  mocks.state.jiraStatusContextKey = null
})
afterEach(cleanup)

function fillSiteAndToken(): void {
  fireEvent.change(screen.getByLabelText('Jira Cloud site URL'), {
    target: { value: 'https://example.atlassian.net' }
  })
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'scoped-token' } })
}

describe('Jira scoped-token connection UI', () => {
  it('requires email until the selected runtime confirms its own scoped-token capability', () => {
    mocks.state.settings.activeRuntimeEnvironmentId = 'new-runtime'
    mocks.state.jiraStatus.supportsScopedTokens = true
    mocks.state.jiraStatusContextKey = getEnvironmentRuntimeContextKey('old-runtime')
    const view = render(<JiraConnectDialog open onOpenChange={vi.fn()} />)
    fillSiteAndToken()
    expect(screen.getByLabelText('Atlassian email')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true)
    mocks.state.jiraStatusContextKey = getEnvironmentRuntimeContextKey('new-runtime')
    view.rerender(<JiraConnectDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByLabelText('Atlassian email (optional for scoped tokens)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', false)
  })

  it('submits an email-free Cloud token to an upgraded host', async () => {
    mocks.state.settings.activeRuntimeEnvironmentId = 'remote-1'
    mocks.state.jiraStatus.supportsScopedTokens = true
    mocks.state.jiraStatusContextKey = getEnvironmentRuntimeContextKey('remote-1')
    render(<JiraConnectDialog open onOpenChange={vi.fn()} />)
    fillSiteAndToken()
    expect(screen.getByLabelText('Atlassian email (optional for scoped tokens)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(mocks.connectJira).toHaveBeenCalledWith({
        siteUrl: 'https://example.atlassian.net',
        email: '',
        apiToken: 'scoped-token',
        authType: 'cloud'
      })
    )
  })

  it('keeps the original email requirement when the remote host omits the capability', () => {
    mocks.state.settings.activeRuntimeEnvironmentId = 'old-remote'
    render(<JiraConnectDialog open onOpenChange={vi.fn()} />)
    fillSiteAndToken()
    expect(screen.getByLabelText('Atlassian email')).toBeTruthy()
    const submit = screen.getByRole('button', { name: 'Connect' })
    expect(submit).toHaveProperty('disabled', true)
    expect(screen.getByText(/Update the remote runtime/)).toBeTruthy()
    fireEvent.click(submit)
    expect(mocks.connectJira).not.toHaveBeenCalled()
  })

  it('shows endpoint diagnostics without marking the token as the failing field', async () => {
    mocks.connectJira.mockResolvedValue({
      ok: false,
      error: 'Could not resolve the Atlassian cloud ID (HTTP 404). Check the Jira Cloud site URL.'
    })
    render(<JiraConnectDialog open onOpenChange={vi.fn()} />)
    fillSiteAndToken()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cloud ID'))
    expect(screen.getByLabelText('API token').getAttribute('aria-invalid')).toBeNull()
  })
})
