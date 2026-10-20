import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import type {
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptPreview
} from '../../../shared/repository-add-script-types'

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  readOutcome: vi.fn(),
  showResult: vi.fn()
}))

vi.mock('./repository-add-script-decision-route', () => ({
  decideRepositoryAddScript: mocks.decide,
  getRepositoryAddScriptOutcome: mocks.readOutcome
}))

vi.mock('@/store/repository-add-script-result', () => ({
  useRepositoryAddScriptResultStore: {
    getState: () => ({ showRepositoryAddScriptResult: mocks.showResult })
  }
}))

vi.mock('sonner', () => {
  const toast = {
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
  return { toast }
})

import { toast } from 'sonner'
import { resolveRepositoryAddScriptPrompt } from './repository-add-script-execution'

const PREVIEW: RepositoryAddScriptPreview = {
  token: 'token-1',
  hostId: 'local',
  hostLabel: 'This computer',
  repoId: 'repo-1',
  path: '/work/project',
  target: { kind: 'native', cwd: '/work/project' },
  script: 'echo hello',
  scriptHash: 'hash-1'
}

const TOAST_ID = 'repository-add-script:token-1'
const IDENTITY = { token: 'token-1', hostId: 'local', repoId: 'repo-1' }

type QuietStatus = 'pending' | 'running' | 'skipped' | 'stale' | 'revoked'

function result(status: QuietStatus): RepositoryAddScriptDecisionResult {
  return { status }
}

function succeeded(): RepositoryAddScriptDecisionResult {
  return { status: 'succeeded', exitCode: 0, output: 'done\n', outputTruncated: false }
}

beforeEach(() => {
  mocks.decide.mockReset()
  mocks.readOutcome.mockReset()
  mocks.showResult.mockReset()
  vi.mocked(toast.loading).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.warning).mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.dismiss).mockReset()
})

describe('repository add script execution', () => {
  it('sends a skip with the preview identity and shows nothing', async () => {
    mocks.decide.mockResolvedValue(result('skipped'))

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'skip')

    expect(mocks.decide).toHaveBeenCalledWith({ ...IDENTITY, decision: 'skip' })
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(mocks.showResult).not.toHaveBeenCalled()
  })

  it('updates the running toast in place when the script succeeds', async () => {
    mocks.decide.mockResolvedValue(succeeded())

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.decide).toHaveBeenCalledWith({ ...IDENTITY, decision: 'run' })
    expect(toast.loading).toHaveBeenCalledWith(expect.any(String), {
      id: TOAST_ID,
      description: PREVIEW.path,
      duration: Infinity
    })
    expect(toast.success).toHaveBeenCalledWith(expect.any(String), {
      id: TOAST_ID,
      description: PREVIEW.path,
      duration: 4000
    })
    expect(mocks.showResult).not.toHaveBeenCalled()
  })

  it('shows a failure result with the real exit code and marks truncation', async () => {
    mocks.decide.mockResolvedValue({
      status: 'failed',
      exitCode: 2,
      output: 'boom\n',
      outputTruncated: true
    })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(toast.dismiss).toHaveBeenCalledWith(TOAST_ID)
    expect(mocks.showResult).toHaveBeenCalledWith({
      status: 'failed',
      path: PREVIEW.path,
      hostLabel: PREVIEW.hostLabel,
      exitCode: 2,
      output: 'boom\n',
      outputTruncated: true
    })
  })

  it('never invents an exit code when the outcome has none', async () => {
    mocks.decide.mockResolvedValue({
      status: 'failed',
      output: 'killed\n',
      outputTruncated: false
    })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    const shown = mocks.showResult.mock.calls[0]?.[0]
    expect(shown.exitCode).toBeUndefined()
    expect(shown.exitCode).not.toBe(0)
  })

  it('shows a result when the script could not be executed at all', async () => {
    mocks.decide.mockResolvedValue({ status: 'failed', reason: 'execution-failed' })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.showResult).toHaveBeenCalledWith({
      status: 'failed',
      reason: 'execution-failed',
      path: PREVIEW.path,
      hostLabel: PREVIEW.hostLabel,
      output: '',
      outputTruncated: false
    })
  })

  it('presents an unverifiable stop as its own result, not an ordinary failure', async () => {
    mocks.decide.mockResolvedValue({
      status: 'unverifiable',
      output: 'partial\n',
      outputTruncated: false
    })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.showResult).toHaveBeenCalledWith({
      status: 'unverifiable',
      path: PREVIEW.path,
      hostLabel: PREVIEW.hostLabel,
      output: 'partial\n',
      outputTruncated: false
    })
  })

  it('shows nothing extra for an outcome the user already resolved', async () => {
    mocks.decide.mockResolvedValue(result('stale'))

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(toast.dismiss).toHaveBeenCalledWith(TOAST_ID)
    expect(mocks.showResult).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reports a rejected decision instead of pretending the script ran', async () => {
    mocks.decide.mockResolvedValue({ status: 'rejected', reason: 'identity-mismatch' })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(toast.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: TOAST_ID })
    )
    expect(mocks.showResult).not.toHaveBeenCalled()
  })

  it('never resends run after a timeout and reads the same identity instead', async () => {
    mocks.decide.mockRejectedValue(new Error('timeout'))
    mocks.readOutcome.mockResolvedValue(succeeded())

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(mocks.readOutcome).toHaveBeenCalledTimes(1)
    expect(mocks.readOutcome).toHaveBeenCalledWith(IDENTITY)
    expect(toast.success).toHaveBeenCalled()
  })

  it('warns that the script may still be running when the outcome stays unknown', async () => {
    mocks.decide.mockRejectedValue(new Error('disconnected'))
    mocks.readOutcome.mockRejectedValue(new Error('still disconnected'))

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(expect.any(String), {
      id: TOAST_ID,
      description: expect.stringContaining('may still be running'),
      duration: Infinity,
      action: expect.objectContaining({ label: expect.any(String) })
    })
    expect(mocks.showResult).not.toHaveBeenCalled()
  })

  it('checks again only by reading the same outcome, never resending run', async () => {
    mocks.decide.mockRejectedValue(new Error('disconnected'))
    mocks.readOutcome
      .mockRejectedValueOnce(new Error('still disconnected'))
      .mockResolvedValueOnce(succeeded())

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    const action = vi.mocked(toast.warning).mock.calls[0]?.[1]?.action
    if (typeof action !== 'object' || action === null || !('onClick' in action)) {
      throw new Error('expected a toast action')
    }
    const onClick: unknown = action.onClick
    expect(onClick).toBeTypeOf('function')
    if (typeof onClick !== 'function') {
      throw new Error('expected a click handler')
    }
    Reflect.apply(onClick, undefined, [{ preventDefault: vi.fn() }])

    await vi.waitFor(() => expect(mocks.readOutcome).toHaveBeenCalledTimes(2))
    expect(mocks.readOutcome).toHaveBeenNthCalledWith(1, IDENTITY)
    expect(mocks.readOutcome).toHaveBeenNthCalledWith(2, IDENTITY)
    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalled()
  })

  it('says nothing ran when the decision was refused before it was sent', async () => {
    mocks.decide.mockRejectedValue(
      new RepositoryAddScriptNotSentError('This repository add script belongs to a different host.')
    )

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(mocks.readOutcome).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('The add script was not started', {
      id: TOAST_ID,
      description: 'Orca could not send this request to This computer. Nothing ran.',
      duration: 6000
    })
    expect(vi.mocked(toast.warning).mock.calls[0]?.[1]).not.toHaveProperty('action')
    expect(mocks.showResult).not.toHaveBeenCalled()
  })

  it('treats a failed capability probe before the send as not started', async () => {
    mocks.decide.mockRejectedValue(new RepositoryAddScriptNotSentError('status unavailable'))

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.readOutcome).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('The add script was not started', {
      id: TOAST_ID,
      description: 'Orca could not send this request to This computer. Nothing ran.',
      duration: 6000
    })
  })

  it('does not claim lost contact when a paired host is too old for add scripts', async () => {
    mocks.decide.mockRejectedValue(
      new RepositoryAddScriptNotSentError(
        'Update this Orca server to run a repository add script from here.'
      )
    )

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(mocks.readOutcome).not.toHaveBeenCalled()
    const description = vi.mocked(toast.warning).mock.calls[0]?.[1]?.description
    expect(description).not.toContain('may still be running')
    expect(toast.warning).toHaveBeenCalledWith(
      'The add script was not started',
      expect.objectContaining({ duration: 6000 })
    )
  })

  it('keeps warning when the decision itself returns a non-terminal status', async () => {
    mocks.decide.mockResolvedValue({ status: 'running' })

    await resolveRepositoryAddScriptPrompt(PREVIEW, 'run')

    expect(toast.warning).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
