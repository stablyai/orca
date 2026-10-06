// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentLaunchProfile, ProfileAgent } from '../../../../shared/agent-launch-profile'
import type { AgentProfileCandidate } from '../../../../shared/agent-profile-connection'
import { AgentLaunchProfiles } from './AgentLaunchProfiles'
const { openSettingsTarget, fetchSettings } = vi.hoisted(() => ({
  openSettingsTarget: vi.fn(),
  fetchSettings: vi.fn(async () => {})
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openSettingsTarget, fetchSettings }) }
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
const preview = vi.fn()
const save = vi.fn()
const unlink = vi.fn()
const addClaude = vi.fn()
const addCodex = vi.fn()
const cancel = vi.fn()
const pickFolder = vi.fn()
const select = vi.fn()
const remove = vi.fn()
const profile = (agent: ProfileAgent): AgentLaunchProfile => ({
  id: 'work',
  name: 'Work',
  agent,
  hostId: 'local',
  executable: `/bin/${agent}`,
  binding: { kind: 'managed', accountId: 'a' }
})
const candidate = (agent: ProfileAgent): AgentProfileCandidate => ({
  ...profile(agent),
  resolvedHome: `/profiles/${agent}`,
  identity: { kind: 'verified', subject: 'a', displayName: 'work@example.test' }
})
function setup(agent: ProfileAgent, editing = false) {
  const settings = {
    ...getDefaultSettings('/tmp/profile-ui'),
    agentLaunchProfiles: editing ? [profile(agent)] : [],
    claudeManagedAccounts: editing
      ? [
          {
            id: 'a',
            email: 'account@example.test',
            managedAuthPath: '/profiles/claude',
            authMethod: 'subscription-oauth' as const,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      : [],
    codexManagedAccounts: editing
      ? [
          {
            id: 'a',
            email: 'account@example.test',
            managedHomePath: '/profiles/codex',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      : []
  }
  render(<AgentLaunchProfiles agent={agent} settings={settings} />)
  fireEvent.click(screen.getByRole('button', { name: editing ? 'Edit' : 'Add profile' }))
  if (!editing) {
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Work' } })
  }
}
async function checkAndSave() {
  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
  await waitFor(() => expect(screen.getByText('work@example.test')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
}
beforeEach(() => {
  vi.clearAllMocks()
  save.mockResolvedValue(profile('claude'))
  unlink.mockResolvedValue(undefined)
  cancel.mockResolvedValue(true)
  pickFolder.mockResolvedValue('/profiles/external')
  addClaude.mockResolvedValue({ accounts: [{ id: 'a', email: 'account@example.test' }] })
  addCodex.mockResolvedValue({ accounts: [{ id: 'a', email: 'account@example.test' }] })
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentProfiles: { preview, save, unlink },
      repos: { pickFolder },
      claudeAccounts: { add: addClaude, cancelPendingLogin: cancel, select, remove },
      codexAccounts: { add: addCodex, cancelPendingLogin: cancel, select, remove }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe.each(['claude', 'codex'] as const)('%s shared profile form', (agent) => {
  it('enrolls without activation, previews and saves through typed profile API', async () => {
    preview.mockResolvedValue(candidate(agent))
    setup(agent)
    expect(screen.getByRole('button', { name: 'Save profile' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to another account' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox').textContent).toContain('account@example.test')
    )
    await checkAndSave()
    expect(agent === 'claude' ? addClaude : addCodex).toHaveBeenCalledWith(
      agent === 'claude' ? { runtime: 'host' } : { runtime: 'host', activate: false }
    )
    expect(preview).toHaveBeenCalledWith({ agent, source: { kind: 'managed', accountId: 'a' } })
    expect(save).toHaveBeenCalledWith({
      name: 'Work',
      connection: { agent, source: { kind: 'managed', accountId: 'a' } }
    })
    expect(fetchSettings).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
  it('coalesces same-render sign-in clicks and selects each sequentially added account', async () => {
    let finish!: (value: { accounts: { id: string; email: string }[] }) => void
    const add = agent === 'claude' ? addClaude : addCodex
    add.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    setup(agent)
    const signIn = screen.getByRole('button', { name: 'Sign in to another account' })
    act(() => {
      fireEvent.click(signIn)
      fireEvent.click(signIn)
    })
    expect(add).toHaveBeenCalledOnce()
    const first = { id: 'a', email: 'first@example.test' }
    await act(async () => finish({ accounts: [first] }))
    expect(screen.getByRole('combobox').textContent).toContain(first.email)
    add.mockResolvedValueOnce({ accounts: [first, { id: 'b', email: 'second@example.test' }] })
    fireEvent.click(signIn)
    await waitFor(() =>
      expect(screen.getByRole('combobox').textContent).toContain('second@example.test')
    )
    expect(add).toHaveBeenCalledTimes(2)
    preview.mockResolvedValue(candidate(agent))
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith({ agent, source: { kind: 'managed', accountId: 'b' } })
    )
  })
  it('offers folder fallback for an unresolved alias and invalidates a changed preview', async () => {
    preview.mockRejectedValueOnce(
      new Error('Command cannot be safely resolved. Choose a configuration folder.')
    )
    setup(agent)
    fireEvent.click(screen.getByRole('radio', { name: 'Connect existing' }))
    fireEvent.change(screen.getByLabelText('Command or alias'), { target: { value: 'work-agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Choose a configuration folder')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Configuration folder').getAttribute('value')).toBe(
        '/profiles/external'
      )
    )
    preview.mockResolvedValue({
      ...candidate(agent),
      binding: { kind: 'external', home: '/profiles/external' },
      identity: { kind: 'unverified', reason: 'No read-only reader' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await waitFor(() => expect(screen.getByText('Unverified configuration')).toBeTruthy())
    expect(screen.getByText(/Starts a new terminal/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Configuration folder'), {
      target: { value: '/different' }
    })
    expect(screen.queryByText('Unverified configuration')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save profile' }).hasAttribute('disabled')).toBe(true)
  })
  it('ignores an old preview after cancellation and reopening', async () => {
    let resolve!: (value: AgentProfileCandidate) => void
    preview.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    setup(agent)
    fireEvent.click(screen.getByRole('radio', { name: 'Connect existing' }))
    fireEvent.change(screen.getByLabelText('Command or alias'), { target: { value: 'work-agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    await act(async () => resolve(candidate(agent)))
    expect(screen.queryByText('work@example.test')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
  it('cancels pending sign-in without creating a launcher or deleting an account', async () => {
    let resolve!: (value: { accounts: { id: string; email: string }[] }) => void
    const add = agent === 'claude' ? addClaude : addCodex
    add.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    setup(agent)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to another account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => resolve({ accounts: [{ id: 'late', email: 'late@example.test' }] }))
    expect(fetchSettings).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
  it('keeps failed sign-in inline and never creates a launcher', async () => {
    ;(agent === 'claude' ? addClaude : addCodex).mockRejectedValueOnce(
      new Error('Sign-in cancelled')
    )
    setup(agent)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to another account' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Sign-in cancelled'))
    expect(fetchSettings).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
  it('renames and unlinks via the host while preserving accounts', async () => {
    preview.mockResolvedValue(candidate(agent))
    setup(agent, true)
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed' } })
    await checkAndSave()
    expect(save).toHaveBeenCalledWith({
      id: 'work',
      name: 'Renamed',
      connection: { agent, source: { kind: 'managed', accountId: 'a' } }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(unlink).toHaveBeenCalledWith('work'))
    expect(remove).not.toHaveBeenCalled()
  })
})
