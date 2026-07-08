// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JiraConnectDialog } from './jira-connect-dialog'

type StoreState = {
  connectJira: (
    args: unknown
  ) => Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }>
  settings: { activeRuntimeEnvironmentId: string | null }
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null },
  connectJira: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

function installStore(): void {
  mocks.store.current = {
    connectJira: mocks.connectJira,
    settings: { activeRuntimeEnvironmentId: null }
  }
}

function inputValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value
}

describe('JiraConnectDialog', () => {
  beforeEach(() => {
    installStore()
    mocks.connectJira.mockReset()
    mocks.connectJira.mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } })
    Object.assign(window, {
      api: {
        shell: {
          openUrl: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    mocks.store.current = null
    Reflect.deleteProperty(window, 'api')
  })

  it('uses a Server/Data Center URL placeholder in server mode', () => {
    render(<JiraConnectDialog open onOpenChange={() => {}} />)

    expect(screen.getByPlaceholderText('https://example.atlassian.net')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))

    expect(screen.getByPlaceholderText('https://jira.example.com')).toBeTruthy()
  })

  it('clears inactive credential fields when switching Jira modes', () => {
    render(<JiraConnectDialog open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByLabelText('Atlassian email'), {
      target: { value: 'ada@example.com' }
    })
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cloud-secret' } })

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Cloud' }))

    expect(inputValue('Atlassian email')).toBe('')
    expect(inputValue('API token')).toBe('')
  })

  it('clears inactive Server/Data Center credential fields when switching auth modes', () => {
    render(<JiraConnectDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    fireEvent.change(screen.getByLabelText('Password or token'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Bearer PAT' }))
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'pat-secret' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Username + password/PAT' }))

    expect(inputValue('Username')).toBe('')
    expect(inputValue('Password or token')).toBe('')

    fireEvent.click(screen.getByRole('radio', { name: 'Bearer PAT' }))

    expect(inputValue('Bearer token')).toBe('')
  })

  it('clears credentials when the dialog closes without connecting', () => {
    const openChanges: boolean[] = []
    const { rerender } = render(
      <JiraConnectDialog open onOpenChange={(open) => openChanges.push(open)} />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    fireEvent.change(screen.getByLabelText('Jira site URL'), {
      target: { value: 'https://jira.example.internal' }
    })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    fireEvent.change(screen.getByLabelText('Password or token'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    rerender(<JiraConnectDialog open={false} onOpenChange={(open) => openChanges.push(open)} />)
    rerender(<JiraConnectDialog open onOpenChange={(open) => openChanges.push(open)} />)

    expect(openChanges).toContain(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    expect(inputValue('Jira site URL')).toBe('')
    expect(inputValue('Username')).toBe('')
    expect(inputValue('Password or token')).toBe('')
  })

  it('submits Jira Server Basic credentials', async () => {
    render(<JiraConnectDialog open onOpenChange={() => {}} />)

    expect(screen.getByText(/Cloud or Server\/Data Center site/)).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    fireEvent.change(screen.getByLabelText('Jira site URL'), {
      target: { value: 'https://jira.example.internal' }
    })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    fireEvent.change(screen.getByLabelText('Password or token'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(mocks.connectJira).toHaveBeenCalledWith({
        deploymentType: 'server',
        authMode: 'basic',
        siteUrl: 'https://jira.example.internal',
        username: 'ada',
        passwordOrToken: 'secret'
      })
    })
  })

  it('submits Jira Server Bearer credentials', async () => {
    render(<JiraConnectDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Server/Data Center' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Bearer PAT' }))
    fireEvent.change(screen.getByLabelText('Jira site URL'), {
      target: { value: 'https://jira.example.internal' }
    })
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'pat-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(mocks.connectJira).toHaveBeenCalledWith({
        deploymentType: 'server',
        authMode: 'bearer',
        siteUrl: 'https://jira.example.internal',
        bearerToken: 'pat-secret'
      })
    })
  })
})
