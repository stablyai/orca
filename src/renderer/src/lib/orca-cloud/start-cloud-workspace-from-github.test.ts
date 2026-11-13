// @vitest-environment happy-dom
// GH-CREATE-SHEET: a GitHub-only Orca Cloud create runs on the same build sheet as any cloud
// create (a pending creation with the Orca Cloud recipe), streams its build log there, and its Retry
// never makes a second sandbox: after a lost answer it resends the same Idempotency-Key, and after a
// failed open it only opens the sandbox it already has.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  open: vi.fn(
    async (): Promise<
      { ok: true; worktreeId: string | null } | { ok: false; message: string }
    > => ({
      ok: true,
      worktreeId: null
    })
  )
}))

vi.mock('@/components/cloud-workspaces/open-cloud-workspace', () => ({
  openCloudWorkspace: mocks.open
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: vi.fn()
}))

import {
  retryGitHubCloudCreate,
  startCloudWorkspaceFromGitHub
} from './start-cloud-workspace-from-github'
import { resetGitHubCreateKeysForTest } from './github-cloud-create-key'

type CreateArgs = { repoUrl: string; title?: string; provisionId?: string; idempotencyKey?: string }
type ProvisionListener = (event: { provisionId: string; stream: string; chunk: string }) => void

let listener: ProvisionListener | null = null
const createFromGitHub = vi.fn<(args: CreateArgs) => Promise<unknown>>()

beforeEach(() => {
  resetGitHubCreateKeysForTest()
  useAppStore.setState({ pendingWorktreeCreations: {}, activePendingCreationId: null })
  Object.assign(window, {
    api: {
      ...window.api,
      orcaCloudWorkspace: { createFromGitHub },
      cloudWorkspaces: {
        get: vi.fn(async (id: string) => ({ ok: true, value: { id } }))
      },
      ephemeralVm: {
        onProvisionEvent: (callback: ProvisionListener) => {
          listener = callback
          return () => {
            listener = null
          }
        },
        cancelProvision: vi.fn(async () => ({ cancelled: true }))
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

const REQUEST = {
  repoUrl: 'https://github.com/acme/web',
  fullName: 'acme/web',
  prompt: 'Fix login',
  agent: null,
  composerRepoId: 'repo-1'
}

function onlyCreation() {
  const entries = Object.values(useAppStore.getState().pendingWorktreeCreations)
  expect(entries).toHaveLength(1)
  return entries[0]!
}

describe('GitHub-only create on the build sheet', () => {
  it('opens the sheet as an Orca Cloud build and streams its log there', async () => {
    let finish: (value: unknown) => void = () => {}
    createFromGitHub.mockImplementation(
      (args: CreateArgs) =>
        new Promise((resolve) => {
          listener?.({
            provisionId: args.provisionId ?? '',
            stream: 'stderr',
            chunk: '[orca-cloud] provisioning\n'
          })
          finish = resolve
        })
    )
    const started = startCloudWorkspaceFromGitHub(REQUEST)
    const entry = onlyCreation()
    expect(useAppStore.getState().activePendingCreationId).toBe(entry.creationId)
    expect(entry.request.ephemeralVmRecipe?.provider).toBe('orca-cloud')
    expect(entry.request.githubSource).toMatchObject({
      fullName: 'acme/web',
      composerRepoId: 'repo-1'
    })
    expect(entry.request.displayName).toBe('Fix login')
    await vi.waitFor(() =>
      expect(onlyCreation().provisioningLog).toContain('[orca-cloud] provisioning')
    )
    expect(createFromGitHub).toHaveBeenCalledWith({
      repoUrl: REQUEST.repoUrl,
      title: 'Fix login',
      provisionId: entry.creationId,
      idempotencyKey: `create:${entry.creationId}`
    })
    finish({ ok: true, value: { sandboxId: 'sbx_1' } })
    expect(await started).toBe(true)
    // Opened: the workspace replaces the sheet.
    expect(useAppStore.getState().pendingWorktreeCreations).toEqual({})
  })

  it('a billing refusal stays on the sheet with its code for the blocker', async () => {
    createFromGitHub.mockResolvedValue({
      ok: false,
      code: 'entitlement_denied',
      message: 'denied',
      reason: 'cloudPlanRequired'
    })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(false)
    expect(onlyCreation()).toMatchObject({ status: 'error', errorCode: 'cloudPlanRequired' })
  })

  it('Retry after a lost answer resends the same key, so no second sandbox is made', async () => {
    createFromGitHub.mockRejectedValueOnce(new Error('ipc dropped'))
    await startCloudWorkspaceFromGitHub(REQUEST)
    const { creationId } = onlyCreation()
    createFromGitHub.mockResolvedValueOnce({ ok: true, value: { sandboxId: 'sbx_1' } })
    retryGitHubCloudCreate(creationId)
    await vi.waitFor(() => expect(createFromGitHub).toHaveBeenCalledTimes(2))
    const keys = createFromGitHub.mock.calls.map((call) => call[0].idempotencyKey)
    expect(keys[1]).toBe(keys[0])
  })

  it('Retry after an answered failure is a new attempt with a new key', async () => {
    createFromGitHub.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'clone failed' })
    await startCloudWorkspaceFromGitHub(REQUEST)
    const { creationId } = onlyCreation()
    createFromGitHub.mockResolvedValueOnce({ ok: true, value: { sandboxId: 'sbx_2' } })
    retryGitHubCloudCreate(creationId)
    await vi.waitFor(() => expect(createFromGitHub).toHaveBeenCalledTimes(2))
    const keys = createFromGitHub.mock.calls.map((call) => call[0].idempotencyKey)
    expect(keys[1]).toBe(`${keys[0]}:retry-1`)
  })

  it('Retry after a failed open opens the same sandbox and never creates again', async () => {
    createFromGitHub.mockResolvedValue({ ok: true, value: { sandboxId: 'sbx_1' } })
    mocks.open.mockResolvedValueOnce({ ok: false, message: 'pairing failed' })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(false)
    const failed = onlyCreation()
    expect(failed).toMatchObject({ status: 'error', phase: 'creating' })
    retryGitHubCloudCreate(failed.creationId)
    await vi.waitFor(() => expect(useAppStore.getState().pendingWorktreeCreations).toEqual({}))
    expect(createFromGitHub).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenCalledTimes(2)
  })
})
