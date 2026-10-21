import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../shared/repository-add-script-runtime-capabilities'
import { REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS } from '../../../shared/repository-add-script-wire'
import type { RepositoryAddScriptDecision } from '../../../shared/repository-add-script-types'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: mocks.runtimeEnvironmentSupportsCapability
}))

const {
  decideRuntimeRepositoryAddScript,
  getRuntimeRepositoryAddScriptOutcome,
  resolveRuntimeRepositoryAddScriptRequest,
  RuntimeRepositoryAddScriptRouteError,
  RuntimeRepositoryAddScriptUnsupportedError
} = await import('./runtime-repository-add-script')

const ENV = { kind: 'environment', environmentId: 'env-1' } as const
const REMOTE = 'runtime:env-1'
const decision: RepositoryAddScriptDecision = {
  token: 'tok',
  hostId: REMOTE,
  repoId: 'repo-1',
  decision: 'run'
}

describe('paired runtime repository add script client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    mocks.callRuntimeRpc.mockResolvedValue({ result: { status: 'succeeded' } })
  })

  it('opts a paired server in under its own alias only after checking the capability', async () => {
    await expect(resolveRuntimeRepositoryAddScriptRequest(ENV)).resolves.toEqual({
      hostId: REMOTE
    })
    expect(mocks.runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY
    )
  })

  it('sends the registration unchanged to an older server instead of re-routing it', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(false)

    await expect(resolveRuntimeRepositoryAddScriptRequest(ENV)).resolves.toBeUndefined()
  })

  it('sends the registration unchanged when the capability probe itself fails', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockRejectedValue(new Error('status unavailable'))

    // Why: the offer is optional, so an unprovable capability must not fail the registration.
    await expect(resolveRuntimeRepositoryAddScriptRequest(ENV)).resolves.toBeUndefined()
  })

  it('names this app as local without a status probe', async () => {
    await expect(resolveRuntimeRepositoryAddScriptRequest({ kind: 'local' })).resolves.toEqual({
      hostId: 'local'
    })
    expect(mocks.runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
  })

  it('sends the decision once, to its own environment, with a deadline past the script limit', async () => {
    const controller = new AbortController()
    // A whole offer passed by mistake must not travel.
    const wholeOffer = { ...decision, script: 'echo secret', path: '/work/x' }

    await decideRuntimeRepositoryAddScript(ENV, wholeOffer, {
      signal: controller.signal,
      expectedEnvironmentPairingRevision: 7
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'repositoryAddScript.decide',
      { token: 'tok', hostId: REMOTE, repoId: 'repo-1', decision: 'run' },
      {
        signal: controller.signal,
        expectedEnvironmentPairingRevision: 7,
        timeoutMs: REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS
      }
    )
    expect(REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS).toBeGreaterThanOrEqual(150_000)
  })

  it('marks a failed capability probe before the send as not sent', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockRejectedValue(new Error('status unavailable'))

    await expect(decideRuntimeRepositoryAddScript(ENV, decision)).rejects.toBeInstanceOf(
      RepositoryAddScriptNotSentError
    )

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does not resend a decision whose reply was lost', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('timed out'))

    await expect(decideRuntimeRepositoryAddScript(ENV, decision)).rejects.toThrow('timed out')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('reads an outcome by the same full identity without the long deadline', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ outcome: { status: 'running' } })

    await expect(getRuntimeRepositoryAddScriptOutcome(ENV, decision)).resolves.toEqual({
      status: 'running'
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'repositoryAddScript.outcome',
      { token: 'tok', hostId: REMOTE, repoId: 'repo-1' },
      {}
    )
  })

  it.each([
    ['decide', () => decideRuntimeRepositoryAddScript(ENV, decision)],
    ['outcome', () => getRuntimeRepositoryAddScriptOutcome(ENV, decision)]
  ])('refuses %s on an older server and sends nothing', async (_name, call) => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(false)

    await expect(call()).rejects.toBeInstanceOf(RuntimeRepositoryAddScriptUnsupportedError)
    await expect(call()).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['decide', () => decideRuntimeRepositoryAddScript(ENV, { ...decision, hostId: 'local' })],
    [
      'decide',
      () => decideRuntimeRepositoryAddScript(ENV, { ...decision, hostId: 'runtime:env-2' })
    ],
    ['outcome', () => getRuntimeRepositoryAddScriptOutcome({ kind: 'local' }, decision)]
  ])('refuses %s for an offer from another host rather than falling back', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(RuntimeRepositoryAddScriptRouteError)
    await expect(call()).rejects.toBeInstanceOf(RepositoryAddScriptNotSentError)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
