import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRuntimeGenerateCommitMessage,
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimeCommitMessage,
  generateRuntimePullRequestFields
} from './runtime-git-generation-client'
import type {
  RuntimeGenerateCommitMessageOverrides,
  RuntimeGitContext
} from './runtime-git-client-context'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

const mocks = vi.hoisted(() => ({
  transport: vi.fn(),
  capability: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('./runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: mocks.transport
}))
vi.mock('./runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 1
}))

const fields = { base: 'main', title: 'Feature', body: '', draft: false }
const remoteContext: RuntimeGitContext = {
  target: { kind: 'environment', environmentId: 'owner-host' },
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  generationId: 'opaque-request-1'
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  mocks.transport.mockImplementation(async ({ method }) =>
    method === 'status.get'
      ? createCompatibleRuntimeStatusResponse()
      : {
          id: 'generation',
          ok: true,
          result: { success: true, message: 'Feature', fields },
          _meta: { runtimeId: 'owner' }
        }
  )
  mocks.capability.mockResolvedValue(createCompatibleRuntimeStatusResponse())
  mocks.generate.mockResolvedValue({ success: true, message: 'Feature', fields })
  mocks.cancel.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      git: {
        generateCommitMessage: mocks.generate,
        generatePullRequestFields: mocks.generate,
        cancelGenerateCommitMessage: mocks.cancel,
        cancelGeneratePullRequestFields: mocks.cancel
      },
      runtimeEnvironments: { call: mocks.capability }
    }
  })
})

for (const operation of ['commitMessage', 'pullRequest'] as const) {
  describe(`${operation} explicit cancellation before dispatch`, () => {
    const generate = (
      context: RuntimeGitContext,
      isCanceled: () => boolean,
      antigravity = false
    ) => {
      const overrides: RuntimeGenerateCommitMessageOverrides = {
        sourceControlAiResolvedParams: {
          agentId: antigravity ? 'antigravity' : 'codex',
          model: antigravity ? 'default' : 'gpt-5.5'
        }
      }
      return operation === 'commitMessage'
        ? generateRuntimeCommitMessage(context, overrides, isCanceled)
        : generateRuntimePullRequestFields(context, fields, overrides, isCanceled)
    }
    const cancel =
      operation === 'commitMessage'
        ? cancelRuntimeGenerateCommitMessage
        : cancelRuntimeGeneratePullRequestFields

    it('does not dispatch after Stop during the shared runtime compatibility check', async () => {
      const status = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
      mocks.transport.mockImplementation(() => status.promise)
      const state = { canceled: false }
      const result = generate(remoteContext, () => state.canceled)
      await vi.waitFor(() => expect(mocks.transport).toHaveBeenCalledTimes(1))
      state.canceled = true
      status.resolve(createCompatibleRuntimeStatusResponse())
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(mocks.transport).toHaveBeenCalledTimes(1)
      expect(mocks.transport.mock.calls[0][0].method).toBe('status.get')
    })

    it('does not dispatch after Stop during a capability lookup', async () => {
      const status = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
      mocks.capability.mockReturnValue(status.promise)
      const state = { canceled: false }
      const result = generate(remoteContext, () => state.canceled, true)
      expect(mocks.capability).toHaveBeenCalledTimes(1)
      state.canceled = true
      status.resolve(createCompatibleRuntimeStatusResponse())
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(mocks.transport).not.toHaveBeenCalled()
    })

    it('continues dispatch when the owner was not explicitly stopped', async () => {
      const status = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
      mocks.transport.mockImplementationOnce(() => status.promise)
      const result = generate(remoteContext, () => false)
      await vi.waitFor(() => expect(mocks.transport).toHaveBeenCalledTimes(1))
      status.resolve(createCompatibleRuntimeStatusResponse())
      await expect(result).resolves.toMatchObject({ success: true })
      expect(mocks.transport.mock.calls[1][0]).toMatchObject({
        params: { generationId: remoteContext.generationId }
      })
      expect(mocks.transport.mock.calls[1][0]).not.toHaveProperty('isCanceled')
    })

    it('keeps uncanceled transport failures visible', async () => {
      mocks.transport.mockRejectedValue(new Error('Host unavailable'))
      await expect(generate(remoteContext, () => false)).rejects.toThrow('Host unavailable')
    })

    it('forwards the same identity to local Generate and Stop, without serializing the local cancellation check', async () => {
      const context: RuntimeGitContext = {
        ...remoteContext,
        target: { kind: 'local' },
        worktreeId: null
      }
      await generate(context, () => false)
      await cancel(context)
      expect(mocks.generate).toHaveBeenCalledWith(
        expect.objectContaining({ generationId: context.generationId })
      )
      expect(mocks.cancel).toHaveBeenCalledWith({
        worktreePath: '/repo',
        connectionId: undefined,
        generationId: context.generationId
      })
      expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty('isCanceled')
    })

    it('forwards the same identity to remote Generate and Stop', async () => {
      await generate(remoteContext, () => false)
      await cancel(remoteContext)
      expect(mocks.transport.mock.calls.slice(1).map(([args]) => args.params)).toEqual([
        expect.objectContaining({ generationId: remoteContext.generationId }),
        { worktree: 'id:wt-1', generationId: remoteContext.generationId }
      ])
    })

    it('Stop marks the request cancellation so in-flight client guards fire', async () => {
      const generationCancellation = { canceled: false }
      const context = { ...remoteContext, generationCancellation }
      const result = generate(context, () => generationCancellation.canceled)
      void cancel(context)
      expect(generationCancellation.canceled).toBe(true)
      await expect(result).resolves.toMatchObject({ canceled: true })
    })

    it('does not invoke local generation when Stop already landed', async () => {
      await expect(
        generate({ ...remoteContext, target: { kind: 'local' } }, () => true)
      ).resolves.toMatchObject({ canceled: true })
      expect(mocks.generate).not.toHaveBeenCalled()
    })
  })
}
