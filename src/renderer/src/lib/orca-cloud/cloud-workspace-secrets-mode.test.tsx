// @vitest-environment happy-dom
// SECRETS-EFFECTIVE-SHARED: workspace-scoped secrets views ask for exactly what a shared workspace gets
// (no Personal values, SEC-5): the agent host panel's Environment section and the missing-secrets ask.
// The secret request card is covered in use-secret-request-card.test.tsx.
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSecretsEffective } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { useCloudPanelSections } from '@/components/agent-host-panel/cloud-sections/use-cloud-panel-sections'
import { useCloudSecretsAskLoad } from '@/components/cloud-secrets-ask/use-cloud-secrets-ask'
import { cloudWorkspaceSecretsMode } from './cloud-workspace-secrets-mode'

const REPO = 'github.com/acme/web'
const effective = vi.fn()
const workspaceSharing = vi.fn()
const list = vi.fn()

function answer(workspace: 'private' | 'shared'): { ok: true; value: CloudSecretsEffective } {
  return {
    ok: true,
    value: {
      workspace,
      caller: {
        userId: 'u',
        orgId: 'o',
        orgRole: 'member',
        canWrite: { personal: true, org: false, repo: false }
      },
      precedence: { env: ['repo', 'personal', 'org'], agent_key: ['org', 'repo', 'personal'] },
      // What the control plane answers: a shared workspace never lists the Personal value.
      secrets:
        workspace === 'shared'
          ? []
          : [
              {
                name: 'SENTRY_DSN',
                kind: 'env',
                scope: 'personal',
                hint: null,
                updatedAt: 0,
                shadowed: []
              }
            ]
    }
  }
}

function sharing(shared: boolean, isOwner = true) {
  return { ok: true, value: { shared, ownerName: null, isOwner } }
}

beforeEach(() => {
  effective.mockImplementation(async (request: { workspace?: 'shared' }) =>
    answer(request.workspace ?? 'private')
  )
  list.mockResolvedValue({
    ok: true,
    data: {
      environments: [
        {
          name: 'acme-web',
          repos: [{ url: 'https://github.com/acme/web' }],
          envVarNames: ['SENTRY_DSN'],
          activeBuildId: null
        }
      ]
    }
  })
  Object.assign(window, {
    api: { cloudSecrets: { effective, workspaceSharing }, orcaCloudEnvironments: { list } }
  })
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('cloudWorkspaceSecretsMode', () => {
  it('shared or unreadable sharing is "shared"; unshared or no environment is "private"', async () => {
    workspaceSharing.mockResolvedValueOnce(sharing(true))
    expect(await cloudWorkspaceSecretsMode('env-1')).toBe('shared')
    workspaceSharing.mockResolvedValueOnce(sharing(false))
    expect(await cloudWorkspaceSecretsMode('env-1')).toBe('private')
    workspaceSharing.mockResolvedValueOnce({ ok: false, error: 'unavailable' })
    expect(await cloudWorkspaceSecretsMode('env-1')).toBe('shared')
    workspaceSharing.mockRejectedValueOnce(new Error('down'))
    expect(await cloudWorkspaceSecretsMode('env-1')).toBe('shared')
    expect(await cloudWorkspaceSecretsMode(null)).toBe('private')
  })
})

describe('agent host panel Environment section', () => {
  it('asks for the shared view in a shared workspace, the owner’s own included', async () => {
    workspaceSharing.mockResolvedValue(sharing(true, true))
    const { result } = renderHook(() =>
      useCloudPanelSections({ repoKey: REPO, runtimeEnvironmentId: 'env-1', asleep: false })
    )
    await waitFor(() => expect(result.current.load.status).toBe('ready'))
    expect(effective).toHaveBeenCalledWith({ repo: REPO, workspace: 'shared' })
    const load = result.current.load
    expect(load.status === 'ready' && load.data.withoutPersonal).toBe(true)
    expect(load.status === 'ready' && load.data.missing).toEqual(['SENTRY_DSN'])
  })

  it('an unshared workspace keeps the default view', async () => {
    workspaceSharing.mockResolvedValue(sharing(false))
    const { result } = renderHook(() =>
      useCloudPanelSections({ repoKey: REPO, runtimeEnvironmentId: 'env-1', asleep: false })
    )
    await waitFor(() => expect(result.current.load.status).toBe('ready'))
    expect(effective).toHaveBeenCalledWith({ repo: REPO })
    const load = result.current.load
    expect(load.status === 'ready' && load.data.missing).toEqual([])
  })
})

describe('missing-secrets ask', () => {
  it('a shared workspace: shared view, Personal not counted, and the form knows it', async () => {
    workspaceSharing.mockResolvedValue(sharing(true, false))
    const { result } = renderHook(() => useCloudSecretsAskLoad(REPO, 'env-1'))
    await waitFor(() => expect(result.current.load.status).toBe('ready'))
    expect(effective).toHaveBeenCalledWith({ repo: REPO, workspace: 'shared' })
    const load = result.current.load
    expect(load.status === 'ready' && load.data).toMatchObject({
      shared: true,
      missing: ['SENTRY_DSN']
    })
  })

  it('no runtime environment (the build sheet, before the workspace exists): default view', async () => {
    const { result } = renderHook(() => useCloudSecretsAskLoad(REPO))
    await waitFor(() => expect(result.current.load.status).toBe('ready'))
    expect(workspaceSharing).not.toHaveBeenCalled()
    expect(effective).toHaveBeenCalledWith({ repo: REPO })
    const load = result.current.load
    expect(load.status === 'ready' && load.data).toMatchObject({ shared: false, missing: [] })
  })
})
