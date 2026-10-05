// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { resetLspClients } from '@/lib/lsp/lsp-session-opener'
import { RepositoryLanguageServersSection } from './RepositoryLanguageServersSection'

vi.mock('@/lib/lsp/lsp-session-opener', () => ({ resetLspClients: vi.fn() }))
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    prepareCommandForShell: (command: string, shell: string | undefined) => string
    onCommandFinished: (exitCode: number | null) => void
  }) => (
    <div>
      <pre data-testid="install-terminal">
        {props.prepareCommandForShell(props.command, '/bin/zsh')}
      </pre>
      <button onClick={() => props.onCommandFinished(1)}>finish-fail</button>
      <button onClick={() => props.onCommandFinished(0)}>finish-ok</button>
    </div>
  )
}))

const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

describe('RepositoryLanguageServersSection', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: {
        lsp: {
          probe: vi.fn(async () => ({
            typescript: { status: 'bundled' },
            'ruby-lsp': { status: 'installed', version: '0.26.1' },
            solargraph: { status: 'missing' }
          }))
        }
      }
    })
  })
  afterEach(cleanup)

  it('enables the TypeScript server for this project only', async () => {
    const updateRepo = vi.fn(async () => true)
    render(
      <RepositoryLanguageServersSection
        repo={repo}
        updateRepo={updateRepo}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: /typescript/i }))
    expect(updateRepo).toHaveBeenCalledWith('r', {
      languageServers: { enabled: { typescript: true } }
    })
    await waitFor(() => expect(resetLspClients).toHaveBeenCalledTimes(1))
  })

  it('keeps existing command and ruby flags when toggling TypeScript', () => {
    const updateRepo = vi.fn(async () => true)
    const withSettings: Repo = {
      ...repo,
      languageServers: {
        enabled: { 'ruby-lsp': true },
        command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] }
      }
    }
    render(
      <RepositoryLanguageServersSection
        repo={withSettings}
        updateRepo={updateRepo}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: /typescript/i }))
    expect(updateRepo).toHaveBeenCalledWith('r', {
      languageServers: {
        enabled: { 'ruby-lsp': true, typescript: true },
        command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] }
      }
    })
  })

  it('does not reset clients when the update fails', async () => {
    vi.mocked(resetLspClients).mockClear()
    const updateRepo = vi.fn(async () => false)
    render(
      <RepositoryLanguageServersSection
        repo={repo}
        updateRepo={updateRepo}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: /typescript/i }))
    await Promise.resolve()
    await Promise.resolve()
    expect(resetLspClients).not.toHaveBeenCalled()
  })

  it('shows Not installed for a missing enabled Ruby server', async () => {
    const enabled: Repo = { ...repo, languageServers: { enabled: { solargraph: true } } }
    render(
      <RepositoryLanguageServersSection
        repo={enabled}
        updateRepo={vi.fn()}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    expect(await screen.findByText('Not installed')).toBeTruthy()
  })

  it('re-probes when the enabled server changes', async () => {
    const props = { updateRepo: vi.fn(), forceVisible: true, searchQuery: '', searchEntries: [] }
    const { rerender } = render(<RepositoryLanguageServersSection repo={repo} {...props} />)
    await waitFor(() => expect(window.api.lsp.probe).toHaveBeenCalledTimes(1))
    rerender(
      <RepositoryLanguageServersSection
        repo={{ ...repo, languageServers: { enabled: { 'ruby-lsp': true } } }}
        {...props}
      />
    )
    await waitFor(() => expect(window.api.lsp.probe).toHaveBeenCalledTimes(2))
  })

  it('disables controls for remote projects', async () => {
    render(
      <RepositoryLanguageServersSection
        repo={{ ...repo, connectionId: 'ssh-1' }}
        updateRepo={vi.fn()}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /typescript/i }).hasAttribute('disabled')).toBe(
        true
      )
    )
  })

  it('runs the install command from the project directory', async () => {
    window.api.lsp.probe = vi.fn(async () => ({ 'ruby-lsp': { status: 'missing' as const } }))
    render(
      <RepositoryLanguageServersSection
        repo={{ ...repo, languageServers: { enabled: { 'ruby-lsp': true } } }}
        updateRepo={vi.fn()}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /install/i }))
    expect(screen.getByTestId('install-terminal').textContent).toBe(
      "cd -- '/repo' && gem install ruby-lsp"
    )
  })

  it('saves a custom command as argv', async () => {
    const updateRepo = vi.fn(async () => true)
    render(
      <RepositoryLanguageServersSection
        repo={{ ...repo, languageServers: { enabled: { 'ruby-lsp': true } } }}
        updateRepo={updateRepo}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    const input = screen.getByLabelText(/custom command/i)
    fireEvent.change(input, { target: { value: 'bundle exec ruby-lsp' } })
    fireEvent.blur(input)
    expect(updateRepo).toHaveBeenCalledWith('r', {
      languageServers: {
        enabled: { 'ruby-lsp': true },
        command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] }
      }
    })
    await waitFor(() => expect(resetLspClients).toHaveBeenCalled())
  })

  const missingRepo: Repo = { ...repo, languageServers: { enabled: { 'ruby-lsp': true } } }
  const startInstall = async (): Promise<void> => {
    window.api.lsp.probe = vi.fn(async () => ({ 'ruby-lsp': { status: 'missing' as const } }))
    render(
      <RepositoryLanguageServersSection
        repo={missingRepo}
        updateRepo={vi.fn()}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /^install$/i }))
  }

  it('keeps the terminal and shows a failure note when the install fails', async () => {
    await startInstall()
    const before = vi.mocked(window.api.lsp.probe).mock.calls.length
    fireEvent.click(screen.getByText('finish-fail'))
    expect(screen.getByTestId('install-terminal')).toBeTruthy()
    expect(screen.getByText('Install failed. Check the output above.')).toBeTruthy()
    await waitFor(() =>
      expect(vi.mocked(window.api.lsp.probe).mock.calls.length).toBeGreaterThan(before)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('install-terminal')).toBeNull()
  })

  it('closes the terminal and re-probes when the install succeeds', async () => {
    await startInstall()
    const before = vi.mocked(window.api.lsp.probe).mock.calls.length
    fireEvent.click(screen.getByText('finish-ok'))
    expect(screen.queryByTestId('install-terminal')).toBeNull()
    await waitFor(() =>
      expect(vi.mocked(window.api.lsp.probe).mock.calls.length).toBeGreaterThan(before)
    )
  })

  it('closes the install panel when the Ruby server selection changes', async () => {
    const user = userEvent.setup()
    window.api.lsp.probe = vi.fn(async () => ({ 'ruby-lsp': { status: 'missing' as const } }))
    const props = { updateRepo: vi.fn(), forceVisible: true, searchQuery: '', searchEntries: [] }
    const { rerender } = render(<RepositoryLanguageServersSection repo={missingRepo} {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /^install$/i }))
    fireEvent.click(screen.getByText('finish-fail'))
    await user.click(screen.getByRole('combobox', { name: 'Ruby' }))
    await user.click(screen.getByRole('option', { name: 'Solargraph' }))
    rerender(
      <RepositoryLanguageServersSection
        repo={{ ...repo, languageServers: { enabled: { solargraph: true } } }}
        {...props}
      />
    )
    expect(screen.queryByTestId('install-terminal')).toBeNull()
    expect(screen.queryByText('Install failed. Check the output above.')).toBeNull()
  })

  it('does not save when the custom command is unchanged', () => {
    const updateRepo = vi.fn(async () => true)
    render(
      <RepositoryLanguageServersSection
        repo={missingRepo}
        updateRepo={updateRepo}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    )
    const input = screen.getByLabelText(/custom command/i)
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(updateRepo).not.toHaveBeenCalled()
  })
})
