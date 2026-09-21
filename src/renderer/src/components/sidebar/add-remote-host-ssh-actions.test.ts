import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTargetCreateInput } from '../../../../shared/ssh-types'
import { EMPTY_FORM } from '../settings/ssh-target-draft'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), toastMocks)
}))

import {
  addAllSshConfigHostsToOrca,
  loadSshConfigHostsForPicker,
  prefillFormFromSshConfigHost,
  saveNewSshHostFromForm
} from './add-remote-host-ssh-actions'

describe('individual SSH config host selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves effective values while leaving all config identities authoritative', async () => {
    let savedTarget: SshTargetCreateInput | undefined
    const ssh = {
      resolveConfigHost: vi.fn().mockResolvedValue({
        alias: 'prod',
        hostname: 'prod.internal',
        port: 2222,
        username: 'deploy',
        identityFiles: ['/keys/first', '/keys/second'],
        identitiesOnly: true,
        forwardAgent: false,
        gssapiAuthentication: true,
        proxyUseFdpass: false
      }),
      listTargets: vi
        .fn()
        .mockImplementation(async () =>
          savedTarget ? [{ ...savedTarget, id: 'ssh-prod', source: 'manual' as const }] : []
        ),
      addTarget: vi.fn().mockImplementation(async ({ target }) => {
        savedTarget = target
        return { target: { ...target, id: 'ssh-prod', source: 'manual' }, repoReadoptions: [] }
      }),
      listConfigHosts: vi.fn(),
      importConfig: vi.fn()
    }
    const selection = await prefillFormFromSshConfigHost(
      {
        alias: 'prod',
        hostname: '%h.internal',
        port: 22,
        username: '',
        identityFile: '/keys/second',
        alreadyInOrca: false
      },
      ssh
    )

    expect(selection).not.toBeNull()
    const outcome = await saveNewSshHostFromForm({
      form: selection!.form,
      ssh,
      recordSshRepoReadoptions: vi.fn(),
      setSshTargetsMetadata: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })

    expect(outcome).toBe('saved')
    expect(ssh.resolveConfigHost).toHaveBeenCalledWith({ alias: 'prod' })
    expect(savedTarget).toMatchObject({
      label: 'prod',
      configHost: 'prod',
      host: 'prod.internal',
      port: 2222,
      username: 'deploy',
      gssapiAuthentication: true
    })
    expect(savedTarget).not.toHaveProperty('identityFile')
    expect(savedTarget).not.toHaveProperty('source')
  })
})

describe('manual SSH host label fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('labels a bare host with its hostname instead of an empty string', async () => {
    let savedTarget: SshTargetCreateInput | undefined
    const ssh = {
      resolveConfigHost: vi.fn(),
      listTargets: vi.fn().mockResolvedValue([]),
      addTarget: vi.fn().mockImplementation(async ({ target }) => {
        savedTarget = target
        return { target: { ...target, id: 'ssh-1', source: 'manual' }, repoReadoptions: [] }
      }),
      listConfigHosts: vi.fn(),
      importConfig: vi.fn()
    }

    const outcome = await saveNewSshHostFromForm({
      form: { ...EMPTY_FORM, host: '10.0.0.7' },
      ssh,
      recordSshRepoReadoptions: vi.fn(),
      setSshTargetsMetadata: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })

    expect(outcome).toBe('saved')
    expect(savedTarget?.label).toBe('10.0.0.7')
  })
})

describe('bulk add of ~/.ssh/config hosts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The button counts (and promises) only the new hosts the picker listed; re-adopting
  // would resurrect hosts the user deleted, which those counts deliberately omit.
  it('imports without re-adopting deleted aliases', async () => {
    const importConfig = vi.fn().mockResolvedValue({
      targets: [{ id: 'ssh-1', label: 'prod', host: 'prod', port: 22, username: '' }],
      repoReadoptions: []
    })
    const ssh = {
      importConfig,
      listTargets: vi.fn().mockResolvedValue([]),
      addTarget: vi.fn(),
      listConfigHosts: vi.fn(),
      resolveConfigHost: vi.fn()
    }

    const result = await addAllSshConfigHostsToOrca({
      ssh,
      recordSshRepoReadoptions: vi.fn(),
      setSshTargetsMetadata: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })

    expect(result).toEqual({ kind: 'added', count: 1 })
    expect(importConfig).toHaveBeenCalledTimes(1)
    expect(importConfig.mock.calls[0][0]).toBeUndefined()
  })

  it('reports already-synced without clearing tombstones', async () => {
    const importConfig = vi.fn().mockResolvedValue({ targets: [], repoReadoptions: [] })
    const result = await addAllSshConfigHostsToOrca({
      ssh: {
        importConfig,
        listTargets: vi.fn().mockResolvedValue([]),
        addTarget: vi.fn(),
        listConfigHosts: vi.fn(),
        resolveConfigHost: vi.fn()
      },
      recordSshRepoReadoptions: vi.fn(),
      setSshTargetsMetadata: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })

    expect(result).toEqual({ kind: 'already-synced' })
    expect(importConfig.mock.calls[0][0]).toBeUndefined()
  })
})

describe('SSH config picker response admission', () => {
  it('accepts the legacy preload array without exposing an unbounded row list', async () => {
    const hosts = Array.from({ length: 150 }, (_, index) => ({
      alias: `host-${index}`,
      hostname: `host-${index}`,
      port: 22,
      username: '',
      alreadyInOrca: index === 0
    }))
    const result = await loadSshConfigHostsForPicker({
      listConfigHosts: vi.fn().mockResolvedValue(hosts)
    } as never)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toMatchObject({
        totalHostCount: 150,
        newHostCount: 149,
        matchCount: 150,
        hasMore: true
      })
      expect(result.result.hosts).toHaveLength(100)
    }
  })

  it('explains when a live renderer still has the older preload API', async () => {
    await expect(
      prefillFormFromSshConfigHost(
        {
          alias: 'prod',
          hostname: 'prod',
          port: 22,
          username: '',
          alreadyInOrca: false
        },
        {} as never
      )
    ).rejects.toThrow('Restart Orca')
  })
})
