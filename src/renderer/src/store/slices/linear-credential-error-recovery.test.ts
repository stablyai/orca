import { beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { createTestStore, issue } from './linear-slice-test-harness'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearDisconnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()
const linearListProjects = vi.fn()
const linearGetCustomView = vi.fn()
const linearGetProject = vi.fn()
const linearListProjectIssues = vi.fn()
const linearListCustomViews = vi.fn()
const linearListCustomViewIssues = vi.fn()
const linearListCustomViewProjects = vi.fn()
const linearTestConnection = vi.fn()

vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearConnect: (...args: unknown[]) => linearConnect(...args),
    linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
    linearDisconnectWorkspace: vi.fn(),
    linearGetCustomView: (...args: unknown[]) => linearGetCustomView(...args),
    linearGetProject: (...args: unknown[]) => linearGetProject(...args),
    linearGetIssue: (...args: unknown[]) => linearGetIssue(...args),
    linearListCustomViewIssues: (...args: unknown[]) => linearListCustomViewIssues(...args),
    linearListCustomViewProjects: (...args: unknown[]) => linearListCustomViewProjects(...args),
    linearListCustomViews: (...args: unknown[]) => linearListCustomViews(...args),
    linearListIssues: (...args: unknown[]) => linearListIssues(...args),
    linearListProjectIssues: (...args: unknown[]) => linearListProjectIssues(...args),
    linearListProjects: (...args: unknown[]) => linearListProjects(...args),
    linearListTeams: (...args: unknown[]) => linearListTeams(...args),
    linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
    linearSelectWorkspace: vi.fn(),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
  }
})

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

describe('createLinearSlice caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns an empty list and refreshes status on Linear decrypt errors during list reads', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Linear'))
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearListCache: {
        'workspace-1::list::all::36::': { data: { items: [issue('LIN-CACHED')] }, fetchedAt: 1 }
      }
    })
    linearStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      credentialError: error.message
    })
    linearListIssues.mockRejectedValueOnce(error)

    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })
    ).resolves.toMatchObject({ items: [] })
    expect(linearStatus).toHaveBeenCalled()
  })

  it('returns an empty list and refreshes status on Linear decrypt errors during searches', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Linear'))
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' }
    })
    linearStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      credentialError: error.message
    })
    linearSearchIssues.mockRejectedValueOnce(error)

    await expect(store.getState().searchLinearIssues('bug', 36)).resolves.toEqual([])
    expect(linearStatus).toHaveBeenCalled()
  })

  it('clears stale Linear credential errors after successful workspace list reads', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Linear')
    store.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'workspace-1',
        credentialError: staleError
      }
    })
    linearListIssues.mockResolvedValueOnce({ items: [issue('LIN-OK')] })
    linearStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    })

    await expect(
      store.getState().listLinearIssues({ kind: 'list', filter: 'all', limit: 36 }, { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'LIN-OK' }] })
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.credentialError).toBeUndefined()
    })
  })

  it('clears stale Linear credential errors after successful issue detail reads', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Linear')
    store.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'workspace-1',
        credentialError: staleError
      }
    })
    linearGetIssue.mockResolvedValueOnce(issue('LIN-OK'))
    linearStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    })

    await expect(store.getState().fetchLinearIssue('LIN-OK', 'workspace-1')).resolves.toMatchObject(
      {
        id: 'LIN-OK'
      }
    )
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.credentialError).toBeUndefined()
    })
  })

  it('clears stale Linear credential errors after successful scoped collection reads', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Linear')
    store.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'workspace-1',
        credentialError: staleError
      }
    })
    linearListProjectIssues.mockResolvedValueOnce({ items: [issue('LIN-OK')] })
    linearStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    })

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 20, { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'LIN-OK' }] })
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.credentialError).toBeUndefined()
    })
  })

  it('surfaces Linear decrypt errors as workspace errors on project issue reads', async () => {
    const store = createTestStore()
    const error = new Error(credentialDecryptionMessage('Linear'))
    store.setState({
      linearProjectIssueCache: {
        'workspace-1::project-issues::project-1::20': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: 1
        }
      }
    })
    linearStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      credentialError: error.message
    })
    linearListProjectIssues.mockRejectedValueOnce(error)

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 20, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED' }],
      errors: [{ message: error.message }]
    })
    expect(linearStatus).toHaveBeenCalled()
  })
})
