// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryAddScriptNotSentError } from '../../../../shared/repository-add-script-errors'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../../shared/repository-add-script-runtime-capabilities'

const ENV = { id: 'env-1', createdAt: 5, pairingRevision: 9 }
const mocks = vi.hoisted(() => ({
  callRuntimeResultWithOwner: vi.fn(),
  callEnvironmentEnvelope: vi.fn(),
  getRemoteRuntimeStatus: vi.fn(),
  resolveEnvironment: vi.fn(),
  assertActiveEnvironment: vi.fn()
}))

vi.mock('./web-runtime-calls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeResultWithOwner: mocks.callRuntimeResultWithOwner,
  callEnvironmentEnvelope: mocks.callEnvironmentEnvelope,
  getRemoteRuntimeStatus: mocks.getRemoteRuntimeStatus
}))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireActiveEnvironment: () => ENV,
  assertActiveEnvironment: mocks.assertActiveEnvironment,
  resolveEnvironment: mocks.resolveEnvironment,
  invalidateRuntimeWorktreeCaches: vi.fn()
}))

import { createReposApi } from './web-repositories-api'

const REMOTE = 'runtime:env-1'
const repo: Repo = {
  id: 'r1',
  path: '/work/r1',
  displayName: 'r1',
  badgeColor: '',
  addedAt: 1,
  kind: 'git'
}
const preview: RepositoryAddScriptPreview = {
  token: 'tok',
  hostId: REMOTE,
  hostLabel: 'Studio',
  repoId: 'r1',
  path: '/work/r1',
  target: { kind: 'native', cwd: '/work/r1' },
  script: 'echo hi',
  scriptHash: 'hash'
}

function reposApi() {
  const api = createReposApi()
  return api
}

function owned<T>(result: T) {
  return { result, hostId: REMOTE, environmentId: 'env-1' }
}

function supportedHost(supported: boolean): void {
  mocks.getRemoteRuntimeStatus.mockResolvedValue({
    capabilities: supported ? [REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY] : []
  })
}

describe('web repositories API add-script opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.assertActiveEnvironment.mockReset()
    supportedHost(true)
    mocks.resolveEnvironment.mockReturnValue(ENV)
  })

  it('sends no flag and probes nothing without the opt-in', async () => {
    mocks.callRuntimeResultWithOwner.mockResolvedValue(owned({ repo }))

    const result = await reposApi().add({ path: '/work/r1' })

    expect(mocks.getRemoteRuntimeStatus).not.toHaveBeenCalled()
    expect(mocks.callRuntimeResultWithOwner.mock.calls[0]?.[1]).not.toHaveProperty(
      'repositoryAddScriptPreview'
    )
    expect(result).toEqual({ repo: { ...repo, executionHostId: REMOTE } })
  })

  it('sends the flag to a capable host and keeps the host owner stamp beside the offer', async () => {
    mocks.callRuntimeResultWithOwner.mockResolvedValue(
      owned({ repo, repositoryAddScriptPreview: preview })
    )

    const result = await reposApi().add({
      path: '/work/r1',
      repositoryAddScriptPreview: { hostId: REMOTE }
    })

    expect(mocks.callRuntimeResultWithOwner).toHaveBeenCalledWith('repo.add', {
      path: '/work/r1',
      kind: undefined,
      displayName: undefined,
      repositoryAddScriptPreview: { hostId: REMOTE }
    })
    expect(result).toEqual({
      repo: { ...repo, executionHostId: REMOTE },
      repositoryAddScriptPreview: preview
    })
  })

  it('registers on an older host exactly as before and never falls back to this machine', async () => {
    supportedHost(false)
    mocks.callRuntimeResultWithOwner.mockResolvedValue(owned({ repo }))

    const result = await reposApi().create({
      parentPath: '/work',
      name: 'r1',
      kind: 'git',
      repositoryAddScriptPreview: { hostId: REMOTE }
    })

    expect(mocks.callRuntimeResultWithOwner).toHaveBeenCalledWith('repo.create', {
      parentPath: '/work',
      name: 'r1',
      kind: 'git'
    })
    expect(result).not.toHaveProperty('repositoryAddScriptPreview')
  })

  it('refuses an opt-in that names another host before sending anything', async () => {
    await expect(
      reposApi().add({ path: '/work/r1', repositoryAddScriptPreview: { hostId: 'local' } })
    ).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)
    await expect(
      reposApi().add({
        path: '/work/r1',
        repositoryAddScriptPreview: { hostId: 'runtime:env-2' }
      })
    ).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)

    expect(mocks.callRuntimeResultWithOwner).not.toHaveBeenCalled()
  })

  it('drops an offer stamped for a different alias than the one requested', async () => {
    mocks.callRuntimeResultWithOwner.mockResolvedValue(
      owned({ repo, repositoryAddScriptPreview: { ...preview, hostId: 'runtime:env-2' } })
    )

    const result = await reposApi().add({
      path: '/work/r1',
      repositoryAddScriptPreview: { hostId: REMOTE }
    })

    expect(result).not.toHaveProperty('repositoryAddScriptPreview')
  })

  it.each([
    [
      'add',
      () => reposApi().add({ path: '/work/r1', repositoryAddScriptPreview: { hostId: REMOTE } })
    ],
    [
      'create',
      () =>
        reposApi().create({
          parentPath: '/work',
          name: 'r1',
          kind: 'git',
          repositoryAddScriptPreview: { hostId: REMOTE }
        })
    ],
    [
      'clone',
      () =>
        reposApi().clone({
          url: 'https://example.com/r1.git',
          destination: '/work',
          repositoryAddScriptPreview: { hostId: REMOTE }
        })
    ]
  ])('drops an offer for another repo on %s', async (_name, register) => {
    mocks.callRuntimeResultWithOwner.mockResolvedValue(
      owned({ repo, repositoryAddScriptPreview: { ...preview, repoId: 'other-repo' } })
    )

    const result = await register()

    expect(result).not.toHaveProperty('repositoryAddScriptPreview')
    expect(result).toHaveProperty('repo.id', 'r1')
  })

  it('clones to a bare Repo unless the caller opted in, then wraps with the offer', async () => {
    mocks.callRuntimeResultWithOwner.mockResolvedValue(
      owned({ repo, repositoryAddScriptPreview: preview })
    )
    const args = { url: 'https://example.com/r1.git', destination: '/work' }

    const bare = await reposApi().clone(args)
    const wrapped = await reposApi().clone({
      ...args,
      repositoryAddScriptPreview: { hostId: REMOTE }
    })

    expect(bare).toEqual({ ...repo, executionHostId: REMOTE })
    expect(wrapped).toEqual({
      repo: { ...repo, executionHostId: REMOTE },
      repositoryAddScriptPreview: preview
    })
  })

  describe('decide and outcome', () => {
    const decision = { token: 'tok', hostId: REMOTE, repoId: 'r1', decision: 'run' } as const

    it('asks the named host once, pinned to its pairing, with a deadline past the script limit', async () => {
      mocks.callEnvironmentEnvelope.mockResolvedValue({
        ok: true,
        result: { result: { status: 'succeeded', output: '', outputTruncated: false } }
      })

      // A whole offer passed by mistake must not travel.
      const wholeOffer = { ...decision, script: 'echo leaked' }

      const result = await reposApi().decideAddScript(wholeOffer)

      expect(result).toMatchObject({ status: 'succeeded' })
      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledWith(
        'env-1',
        'repositoryAddScript.decide',
        { token: 'tok', hostId: REMOTE, repoId: 'r1', decision: 'run' },
        150_000,
        9
      )
    })

    it('does not resend a decision whose reply was lost', async () => {
      mocks.callEnvironmentEnvelope.mockRejectedValue(new Error('socket closed'))

      await expect(reposApi().decideAddScript(decision)).rejects.toThrow('socket closed')

      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
    })

    it('reads the outcome by identity and returns null for an unknown token', async () => {
      mocks.callEnvironmentEnvelope.mockResolvedValue({ ok: true, result: { outcome: null } })

      await expect(reposApi().getAddScriptOutcome(decision)).resolves.toBeNull()

      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledWith(
        'env-1',
        'repositoryAddScript.outcome',
        { token: 'tok', hostId: REMOTE, repoId: 'r1' },
        undefined,
        9
      )
    })

    it('keeps the host error code on a failed call', async () => {
      mocks.callEnvironmentEnvelope.mockResolvedValue({
        ok: false,
        error: { code: 'invalid_argument', message: 'bad' }
      })

      await expect(reposApi().decideAddScript(decision)).rejects.toMatchObject({
        message: 'bad',
        code: 'invalid_argument'
      })
    })

    it.each([
      ['runtime:active', ENV],
      ['runtime:Studio%20Box', { ...ENV, name: 'Studio Box' }]
    ] as const)(
      'refuses %s, which names a selector and not the environment id',
      async (hostId, env) => {
        mocks.resolveEnvironment.mockReturnValue(env)

        await expect(reposApi().decideAddScript({ ...decision, hostId })).rejects.toThrow(
          'different host'
        )
        await expect(reposApi().getAddScriptOutcome({ ...decision, hostId })).rejects.toThrow(
          'different host'
        )

        expect(mocks.callEnvironmentEnvelope).not.toHaveBeenCalled()
      }
    )

    it('accepts a compatible environment id and keeps the pairing pin', async () => {
      mocks.resolveEnvironment.mockReturnValue({ ...ENV, compatibleEnvironmentIds: ['old-env'] })
      mocks.callEnvironmentEnvelope.mockResolvedValue({ ok: true, result: { outcome: null } })

      await reposApi().getAddScriptOutcome({ ...decision, hostId: 'runtime:old-env' })

      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledWith(
        'env-1',
        'repositoryAddScript.outcome',
        { token: 'tok', hostId: 'runtime:old-env', repoId: 'r1' },
        undefined,
        9
      )
    })

    it('refuses an older host and a local or unknown alias without sending', async () => {
      supportedHost(false)
      await expect(reposApi().decideAddScript(decision)).rejects.toThrow('Update this Orca server')
      supportedHost(true)
      await expect(reposApi().decideAddScript({ ...decision, hostId: 'local' })).rejects.toThrow(
        'different host'
      )
      mocks.resolveEnvironment.mockImplementation(() => {
        throw new Error('Unknown Orca runtime environment: env-2')
      })
      await expect(
        reposApi().getAddScriptOutcome({ ...decision, hostId: 'runtime:env-2' })
      ).rejects.toThrow('Unknown Orca runtime environment')

      expect(mocks.callEnvironmentEnvelope).not.toHaveBeenCalled()
    })

    it('marks every refusal before the send as not sent, and a lost reply as unknown', async () => {
      await expect(
        reposApi().decideAddScript({ ...decision, hostId: 'local' })
      ).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)

      supportedHost(false)
      await expect(reposApi().decideAddScript(decision)).rejects.toBeInstanceOf(
        RepositoryAddScriptNotSentError
      )

      supportedHost(true)
      mocks.resolveEnvironment.mockImplementation(() => {
        throw new Error('Unknown Orca runtime environment: env-2')
      })
      await expect(
        reposApi().getAddScriptOutcome({ ...decision, hostId: 'runtime:env-2' })
      ).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)

      mocks.resolveEnvironment.mockReturnValue(ENV)
      mocks.assertActiveEnvironment.mockImplementation(() => {
        throw new Error('The paired Orca server changed while the request was in progress.')
      })
      await expect(reposApi().decideAddScript(decision)).rejects.toBeInstanceOf(
        RepositoryAddScriptNotSentError
      )

      // The request did leave this client, so its fate is unknown, not "nothing ran".
      mocks.assertActiveEnvironment.mockReset()
      mocks.callEnvironmentEnvelope.mockRejectedValue(new Error('socket closed'))
      const lost = await reposApi()
        .decideAddScript(decision)
        .catch((error: unknown) => error)

      expect(lost).toBeInstanceOf(Error)
      expect(lost).not.toBeInstanceOf(RepositoryAddScriptNotSentError)
      expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
    })
  })
})
