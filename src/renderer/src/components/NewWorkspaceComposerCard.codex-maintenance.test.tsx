// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import { resetCodexMaintenanceStoreForTests } from '@/lib/codex-maintenance-store'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  route: vi.fn(),
  capabilities: ['agent-session.structured.v1'],
  state: { settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }, repos: [], projects: [] }
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({ resolveAgentSessionLaunchRoute: mocks.route }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => mocks.capabilities,
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
vi.mock('@/lib/codex-maintenance-client', () => ({
  callCodexMaintenance: mocks.call,
  codexMaintenanceTargetKey: (target: { kind: string }) => `${target.kind}:codex`
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state, subscribe: () => () => {} }
  )
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('./new-workspace/NewWorkspaceComposerProjectSection', () => ({
  NewWorkspaceComposerProjectSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerNameSection', () => ({
  NewWorkspaceComposerNameSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerAdvancedSection', () => ({
  NewWorkspaceComposerAdvancedSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerAgentSection', () => ({
  NewWorkspaceComposerAgentSection: ({ onCreate }: { onCreate: () => void }) => (
    <button onClick={onCreate}>Start from picker</button>
  )
}))
let container: HTMLDivElement | undefined
beforeEach(() => {
  mocks.route.mockReturnValue('structured-native-chat')
  mocks.call.mockReset()
  resetCodexMaintenanceStoreForTests()
})
afterEach(() => {
  if (container) {
    unmountCard(container)
    container = undefined
  }
  resetCodexMaintenanceStoreForTests()
})
describe('workspace composer Codex installation admission', () => {
  it.each([false, true])(
    'blocks the button, picker send and keyboard submit projection when installed=%s',
    async (installed) => {
      mocks.call.mockResolvedValue({
        installation: codexCliInstallation(installed, installed ? '0.135.0' : null),
        evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
        canRun: !installed,
        job: null
      })
      const create = vi.fn()
      container = await renderCard({
        quickAgent: 'codex',
        selectedRepoExecutionHostId: 'local',
        onCreate: create
      })
      await act(async () => {})
      const query = within(container)
      expect(query.getByRole('button', { name: /Create workspace/ })).toBeDisabled()
      expect(container.querySelector('[data-workspace-submit-blocked]')).not.toBeNull()
      fireEvent.click(query.getByRole('button', { name: 'Start from picker' }))
      expect(create).not.toHaveBeenCalled()
      expect(
        query.getByText(
          installed
            ? 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
            : "Codex isn't installed."
        )
      ).toBeInTheDocument()
      // Install Codex lives only in Settings → Agents.
      expect(query.queryByRole('button', { name: 'Install Codex' })).toBeNull()
      expect(mocks.route).toHaveBeenCalledWith(mocks.state, {
        agent: 'codex',
        workspace: { kind: 'git-worktree', repoId: 'repo-a', executionHostId: 'local' }
      })
    }
  )
  it('allows unknown versions and does not gate terminal launches', async () => {
    mocks.call.mockResolvedValue({
      installation: codexCliInstallation(true, null),
      evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
      canRun: true,
      job: null
    })
    const create = vi.fn()
    container = await renderCard({
      quickAgent: 'codex',
      onCreate: create,
      selectedRepoIsGit: false
    })
    fireEvent.click(within(container).getByRole('button', { name: 'Start from picker' }))
    expect(create).toHaveBeenCalledOnce()
    unmountCard(container)
    container = undefined
    mocks.route.mockReturnValue('terminal-tui')
    mocks.call.mockClear()
    container = await renderCard({ quickAgent: 'codex', onCreate: create })
    expect(within(container).getByRole('button', { name: /Create workspace/ })).toBeEnabled()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
