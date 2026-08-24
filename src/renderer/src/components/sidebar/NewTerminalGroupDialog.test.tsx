// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  createTerminalGroup: vi.fn(),
  closeModal: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  repo: null as Repo | null
}))

const state = {
  activeModal: 'new-terminal-group',
  modalData: { repoId: 'repo-1' },
  closeModal: mocks.closeModal,
  createTerminalGroup: mocks.createTerminalGroup,
  detectedAgentIds: null,
  settings: null
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({ useRepoById: () => mocks.repo }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? fallback.replace(/\{\{value(\d)\}\}/g, (_match, index) => String(values[`value${index}`]))
      : fallback
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))

import NewTerminalGroupDialog from './NewTerminalGroupDialog'

const createdWorktree = {
  id: 'repo-1::/workspace/repo::workspace:11111111-1111-4111-8111-111111111111',
  repoId: 'repo-1',
  path: '/workspace/repo'
} as Worktree

beforeEach(() => {
  mocks.repo = {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 0
  } as Repo
  mocks.createTerminalGroup.mockReset().mockResolvedValue(createdWorktree)
  mocks.closeModal.mockReset()
  mocks.activateAndRevealWorktree.mockReset().mockReturnValue({ primaryTabId: 'tab-1' })
  ;(window as unknown as { api: Record<string, unknown> }).api = {}
})

afterEach(() => cleanup())

describe('NewTerminalGroupDialog', () => {
  it('states that the group reuses the project checkout rather than creating a worktree', () => {
    render(<NewTerminalGroupDialog />)

    expect(screen.getByText(/No new worktree, no branch/)).toBeTruthy()
    expect(screen.getByText(/orca/)).toBeTruthy()
  })

  it('creates the group with the typed name and closes', async () => {
    render(<NewTerminalGroupDialog />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'servers' } })
    fireEvent.click(screen.getByText('Create group'))

    await waitFor(() => {
      expect(mocks.createTerminalGroup).toHaveBeenCalledWith({
        repoId: 'repo-1',
        name: 'servers',
        telemetrySource: 'sidebar'
      })
    })
    await waitFor(() => expect(mocks.closeModal).toHaveBeenCalled())
  })

  it('surfaces a create failure instead of closing', async () => {
    mocks.createTerminalGroup.mockRejectedValue(new Error('runtime_unavailable'))
    render(<NewTerminalGroupDialog />)

    fireEvent.click(screen.getByText('Create group'))

    await waitFor(() => expect(screen.getByText('runtime_unavailable')).toBeTruthy())
    expect(mocks.closeModal).not.toHaveBeenCalled()
  })
})
