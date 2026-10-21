import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import type {
  RepositoryAddScriptDecision,
  RepositoryAddScriptIdentity
} from '../../../shared/repository-add-script-types'

const mocks = vi.hoisted(() => ({
  webClient: false,
  decideRuntime: vi.fn(),
  readRuntimeOutcome: vi.fn(),
  decideLocal: vi.fn(),
  readLocalOutcome: vi.fn()
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => mocks.webClient
}))

vi.mock('./runtime-repository-add-script', () => ({
  decideRuntimeRepositoryAddScript: mocks.decideRuntime,
  getRuntimeRepositoryAddScriptOutcome: mocks.readRuntimeOutcome
}))

import {
  decideRepositoryAddScript,
  getRepositoryAddScriptOutcome
} from './repository-add-script-decision-route'

const DECISION: RepositoryAddScriptDecision = {
  token: 'token-1',
  hostId: 'runtime:paired-host',
  repoId: 'repo-1',
  decision: 'run'
}

const IDENTITY: RepositoryAddScriptIdentity = {
  token: 'token-1',
  hostId: 'runtime:paired-host',
  repoId: 'repo-1'
}

function stubDesktopApi(): void {
  vi.stubGlobal('window', {
    api: {
      repos: {
        decideAddScript: mocks.decideLocal,
        getAddScriptOutcome: mocks.readLocalOutcome
      }
    }
  })
}

beforeEach(() => {
  mocks.webClient = false
  mocks.decideRuntime.mockReset()
  mocks.readRuntimeOutcome.mockReset()
  mocks.decideLocal.mockReset()
  mocks.readLocalOutcome.mockReset()
  stubDesktopApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('repository add script decision route', () => {
  it('sends a web decision through the web preload, which owns alias routing', async () => {
    mocks.webClient = true
    mocks.decideLocal.mockResolvedValue({ status: 'pending' })

    await expect(decideRepositoryAddScript(DECISION)).resolves.toEqual({ status: 'pending' })

    expect(mocks.decideLocal).toHaveBeenCalledWith(DECISION)
    expect(mocks.decideRuntime).not.toHaveBeenCalled()
  })

  it('reads a web outcome through the web preload', async () => {
    mocks.webClient = true
    mocks.readLocalOutcome.mockResolvedValue({ status: 'running' })

    await expect(getRepositoryAddScriptOutcome(IDENTITY)).resolves.toEqual({ status: 'running' })

    expect(mocks.readLocalOutcome).toHaveBeenCalledWith(IDENTITY)
    expect(mocks.readRuntimeOutcome).not.toHaveBeenCalled()
  })

  it('sends a local desktop decision through desktop IPC', async () => {
    const localDecision: RepositoryAddScriptDecision = { ...DECISION, hostId: 'local' }
    mocks.decideLocal.mockResolvedValue({ status: 'skipped' })

    await decideRepositoryAddScript(localDecision)

    expect(mocks.decideLocal).toHaveBeenCalledWith(localDecision)
    expect(mocks.decideRuntime).not.toHaveBeenCalled()
  })

  it('reads a local desktop outcome through desktop IPC', async () => {
    const localIdentity: RepositoryAddScriptIdentity = { ...IDENTITY, hostId: 'local' }
    mocks.readLocalOutcome.mockResolvedValue({
      status: 'succeeded',
      output: '',
      outputTruncated: false
    })

    await getRepositoryAddScriptOutcome(localIdentity)

    expect(mocks.readLocalOutcome).toHaveBeenCalledWith(localIdentity)
    expect(mocks.readRuntimeOutcome).not.toHaveBeenCalled()
  })

  it('routes a runtime alias to the paired environment, never desktop IPC', async () => {
    mocks.decideRuntime.mockResolvedValue({ status: 'running' })

    await decideRepositoryAddScript(DECISION)

    expect(mocks.decideRuntime).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'paired-host' },
      DECISION
    )
    expect(mocks.decideLocal).not.toHaveBeenCalled()
  })

  it('reads a runtime alias outcome from the paired environment', async () => {
    mocks.readRuntimeOutcome.mockResolvedValue({ status: 'pending' })

    await getRepositoryAddScriptOutcome(IDENTITY)

    expect(mocks.readRuntimeOutcome).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'paired-host' },
      IDENTITY
    )
    expect(mocks.readLocalOutcome).not.toHaveBeenCalled()
  })

  it('refuses to reroute an SSH alias to this computer', async () => {
    const sshDecision: RepositoryAddScriptDecision = { ...DECISION, hostId: 'ssh:build-box' }

    await expect(decideRepositoryAddScript(sshDecision)).rejects.toBeInstanceOf(
      RepositoryAddScriptNotSentError
    )

    expect(mocks.decideLocal).not.toHaveBeenCalled()
    expect(mocks.decideRuntime).not.toHaveBeenCalled()
  })

  it('refuses to read an SSH alias outcome from this computer', async () => {
    const sshIdentity: RepositoryAddScriptIdentity = { ...IDENTITY, hostId: 'ssh:build-box' }

    await expect(getRepositoryAddScriptOutcome(sshIdentity)).rejects.toBeInstanceOf(
      RepositoryAddScriptNotSentError
    )

    expect(mocks.readLocalOutcome).not.toHaveBeenCalled()
    expect(mocks.readRuntimeOutcome).not.toHaveBeenCalled()
  })

  it('refuses a runtime alias that names no environment', async () => {
    // A broken percent escape cannot decode, so the alias routes nowhere.
    const unparsableDecision: RepositoryAddScriptDecision = {
      ...DECISION,
      hostId: 'runtime:%ZZ'
    }

    await expect(decideRepositoryAddScript(unparsableDecision)).rejects.toBeInstanceOf(
      RepositoryAddScriptNotSentError
    )

    expect(mocks.decideLocal).not.toHaveBeenCalled()
    expect(mocks.decideRuntime).not.toHaveBeenCalled()
  })
})
