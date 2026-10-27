import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import zh from '../../i18n/locales/zh.json'
import { recordRuntimeSubscription } from '@/runtime/runtime-environment-bridge-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import {
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentSubscribe,
  runtimeEnvironmentTransportCall
} from '../slices/github-slice-test-harness'

import {
  check,
  prRepo,
  details,
  surfaces,
  transports,
  createLoader,
  expectRequestCounts,
  successResponse,
  type Surface
} from './check-details-loader-test-fixture'
import * as normalization from '@/lib/check-run-details-log-normalization'
import * as sanitation from '../../../../shared/check-job-log-excerpt'
import {
  checkLogJob,
  legacyControls,
  expectedLegacyControls
} from '@/lib/check-run-details-log-normalization-test-fixture'

vi.mock('@/i18n/i18n', async () => {
  const { default: catalog } = await import('../../i18n/locales/zh.json')
  const messages: Record<string, string> = {
    'auto.runtime.githubCheckDetailsTimeout.timedOut':
      catalog.auto.runtime.githubCheckDetailsTimeout.timedOut,
    'auto.store.slices.editor.checkRunDetailsLoadFailed':
      catalog.auto.store.slices.editor.checkRunDetailsLoadFailed,
    'auto.components.GitHubItemDialog.e45324fbed':
      catalog.auto.components.GitHubItemDialog.e45324fbed,
    'auto.components.PullRequestPage.e04c027d98': catalog.auto.components.PullRequestPage.e04c027d98
  }
  return { translate: (key: string, fallback: string) => messages[key] ?? fallback }
})

const timeoutMessage = zh.auto.runtime.githubCheckDetailsTimeout.timedOut
const genericMessages = {
  store: zh.auto.store.slices.editor.checkRunDetailsLoadFailed,
  dialog: zh.auto.components.GitHubItemDialog.e45324fbed,
  page: zh.auto.components.PullRequestPage.e04c027d98
}
type Loader = ReturnType<typeof createLoader>
function expectFailure(loader: Loader, surface: Surface, message: string, original?: unknown) {
  if (surface === 'store') {
    const result = loader.storeSettlement()
    expect(result?.status).toBe('rejected')
    if (result?.status !== 'rejected' || !(result.error instanceof Error)) {
      throw new Error('Expected a fresh rejected Error')
    }
    expect(result.error.message).toBe(message)
    expect(result.error).not.toBe(original)
    expect(result.error.name).toBe(message === 'Runtime request aborted' ? 'AbortError' : 'Error')
    const fixedFields =
      message === 'Runtime request aborted' ? ['message', 'name', 'stack'] : ['message', 'stack']
    const localFields = process.versions.bun ? ['line', 'column', 'sourceURL'] : []
    expect(
      Reflect.ownKeys(result.error).every(
        (key) => typeof key === 'string' && [...fixedFields, ...localFields].includes(key)
      )
    ).toBe(true)
    expect(Object.hasOwn(result.error, 'message')).toBe(true)
    expect(Object.hasOwn(result.error, 'stack')).toBe(true)
    for (const key of localFields) {
      const value: unknown = Object.getOwnPropertyDescriptor(result.error, key)?.value
      if (value !== undefined) {
        expect(typeof value).toBe(key === 'sourceURL' ? 'string' : 'number')
        expect(String(value)).not.toContain('SYNTHETIC_SECRET')
      }
    }
    expect(result.error.stack).not.toContain('SYNTHETIC_SECRET')
    expect(JSON.stringify(loader.store.getState())).not.toContain('SYNTHETIC_SECRET')
  } else {
    expect(loader.state().detailsByCheckKey.check).toEqual({
      requestId: loader.ctx.nextCheckDetailsRequestIdRef.current,
      loading: false,
      details: null,
      error: message
    })
    expect(JSON.stringify(loader.state())).not.toContain('SYNTHETIC_SECRET')
  }
  expect(normalization.normalizeCheckRunDetailsLogTails).not.toHaveBeenCalled()
  expect(sanitation.sanitizeCheckJobLogExcerpt).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
}

function hostileError(message = 'SYNTHETIC_SECRET_message') {
  return Object.assign(new Error(message), {
    stack: 'SYNTHETIC_SECRET_stack',
    stdout: 'SYNTHETIC_SECRET_stdout',
    stderr: 'SYNTHETIC_SECRET_stderr',
    cause: { message: 'SYNTHETIC_SECRET_cause', cause: new Error('SYNTHETIC_SECRET_nested') },
    code: 'SYNTHETIC_SECRET_code',
    response: { error: { message: 'SYNTHETIC_SECRET_rpc' } },
    line: 'SYNTHETIC_SECRET_line',
    column: 'SYNTHETIC_SECRET_column',
    sourceURL: 'SYNTHETIC_SECRET_sourceURL',
    arbitrary: 'SYNTHETIC_SECRET_property'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  resetRemoteRuntimeMocks()
  mockApi.gh.prCheckDetails.mockReset()
  mockApi.runtimeEnvironments.cancelSubscription.mockClear()
  vi.spyOn(normalization, 'normalizeCheckRunDetailsLogTails')
  vi.spyOn(sanitation, 'sanitizeCheckJobLogExcerpt')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

for (const surface of surfaces) {
  for (const transport of transports) {
    describe(`${surface} check-details failure mapping over ${transport}`, () => {
      it('keeps source-owned routing, fork/enterprise identity and a single request', async () => {
        const subscription = recordRuntimeSubscription()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        mockApi.gh.prCheckDetails.mockResolvedValue(details)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        if (transport === 'rpc') {
          expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
            {
              subscriptionId: expect.any(String),
              selector: 'source-env',
              method: 'github.prCheckDetails',
              params: {
                repo: 'source-repo-id',
                checkRunId: 123,
                workflowRunId: 456,
                checkName: check.name,
                url: check.url,
                prRepo
              },
              timeoutMs: 30_000,
              expectedEnvironmentPairingRevision: undefined,
              expectedEnvironmentRuntimeId: undefined
            },
            expect.any(Object)
          )
          subscription.respond(successResponse())
        } else {
          expect(mockApi.gh.prCheckDetails).toHaveBeenCalledWith({
            repoPath: '/folder',
            repoId: 'caller-repo',
            sourceContext: loader.ctx.sourceContext,
            checkRunId: 123,
            workflowRunId: 456,
            checkName: check.name,
            url: check.url,
            prRepo
          })
        }
        await vi.advanceTimersByTimeAsync(0)
        if (surface === 'store') {
          expect(loader.storeSettlement()).toEqual({ status: 'fulfilled', details })
        } else {
          expect(loader.state().detailsByCheckKey.check).toMatchObject({
            loading: false,
            details,
            error: null
          })
        }
        expectRequestCounts(transport)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('preserves the real wrapper Chinese translation of host timeout failures', async () => {
        const original = hostileError(
          "SYNTHETIC_SECRET_host Error invoking remote method 'gh:prCheckDetails': Error: Timed out loading check details."
        )
        const subscription = recordRuntimeSubscription()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        mockApi.gh.prCheckDetails.mockRejectedValue(original)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        if (transport === 'rpc') {
          subscription.respond({
            id: 'failed-host',
            ok: false,
            error: { code: 'runtime_error', message: original.message, data: original },
            _meta: { runtimeId: 'source-runtime' }
          })
        }
        await vi.advanceTimersByTimeAsync(0)
        expectFailure(loader, surface, timeoutMessage, original)
        expectRequestCounts(transport)
        if (transport === 'rpc') {
          expect(subscription.unsubscribe).toHaveBeenCalledOnce()
        }
      })

      it('discards hostile generic rejection fields and preserves failure settlement', async () => {
        const original = hostileError()
        mockApi.gh.prCheckDetails.mockRejectedValue(original)
        runtimeEnvironmentSubscribe.mockRejectedValue(original)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        expectFailure(loader, surface, genericMessages[surface], original)
        expectRequestCounts(transport)
      })

      it('replaces a checked abort with the existing fresh fixed abort', async () => {
        const original = hostileError()
        original.name = 'AbortError'
        mockApi.gh.prCheckDetails.mockRejectedValue(original)
        runtimeEnvironmentSubscribe.mockRejectedValue(original)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        expectFailure(loader, surface, 'Runtime request aborted', original)
        expectRequestCounts(transport)
      })

      it('classifies exact translated timeouts before a checked abort', async () => {
        const original = hostileError(timeoutMessage)
        original.name = 'AbortError'
        mockApi.gh.prCheckDetails.mockRejectedValue(original)
        runtimeEnvironmentSubscribe.mockRejectedValue(original)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        expectFailure(loader, surface, timeoutMessage, original)
        expectRequestCounts(transport)
      })

      it.each([
        timeoutMessage,
        { message: timeoutMessage, name: 'AbortError', stdout: 'SYNTHETIC_SECRET_object' },
        new Error(`SYNTHETIC_SECRET_prefix ${timeoutMessage}`),
        new Error(`${timeoutMessage} SYNTHETIC_SECRET_suffix`),
        new Error('SYNTHETIC_SECRET prose AbortError or timeout, not classification')
      ])('requires checked exact localized/abort classification (%#)', async (original) => {
        mockApi.gh.prCheckDetails.mockRejectedValue(original)
        runtimeEnvironmentSubscribe.mockRejectedValue(original)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        expectFailure(loader, surface, genericMessages[surface], original)
        expectRequestCounts(transport)
      })

      it('keeps the 30-second renderer timeout and ignores late details', async () => {
        const upstream = Promise.withResolvers<PRCheckRunDetails>()
        const subscription = recordRuntimeSubscription()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        mockApi.gh.prCheckDetails.mockReturnValue(upstream.promise)
        const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener')
        const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(29_999)
        if (surface === 'store') {
          expect(loader.storeSettlement()).toBeUndefined()
        } else {
          expect(loader.state().detailsByCheckKey.check.loading).toBe(true)
        }
        await vi.advanceTimersByTimeAsync(1)
        expectFailure(loader, surface, timeoutMessage)
        const settledState = loader.state()
        const settledStore = loader.storeSettlement()
        upstream.resolve(details)
        if (transport === 'rpc') {
          subscription.respond(successResponse())
          expect(subscription.unsubscribe).toHaveBeenCalledOnce()
          for (const [index, [event, listener]] of addListener.mock.calls.entries()) {
            if (event !== 'abort') {
              continue
            }
            const signal = addListener.mock.contexts[index]
            if (!(signal instanceof AbortSignal)) {
              throw new Error('Expected the renderer operation signal')
            }
            expect(signal.aborted).toBe(true)
            expect(
              removeListener.mock.calls.some(
                ([removedEvent, removedListener], i) =>
                  removedEvent === 'abort' &&
                  removedListener === listener &&
                  removeListener.mock.contexts[i] === signal
              )
            ).toBe(true)
          }
          expect(addListener.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2)
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(loader.state()).toBe(settledState)
        expect(loader.storeSettlement()).toBe(settledStore)
        expectRequestCounts(transport)
        expect(vi.getTimerCount()).toBe(0)
      })
    })
  }
}

for (const surface of surfaces) {
  describe(`${surface} RPC details deadline and envelope safety`, () => {
    const transport = 'rpc'
    it('drops secret fields retained by the actual RPC failure envelope', async () => {
      const subscription = recordRuntimeSubscription()
      runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
      const loader = createLoader(surface, transport)
      loader.start()
      await vi.advanceTimersByTimeAsync(0)
      const response = {
        id: 'SYNTHETIC_SECRET_id',
        ok: false,
        error: {
          code: 'SYNTHETIC_SECRET_code',
          message: 'SYNTHETIC_SECRET_message',
          data: hostileError()
        },
        _meta: { runtimeId: 'SYNTHETIC_SECRET_runtime' }
      }
      subscription.respond(response)
      await vi.advanceTimersByTimeAsync(0)
      expectFailure(loader, surface, genericMessages[surface], response)
      expectRequestCounts(transport)
      expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    })

    it('bounds stalled compatibility and starts no child after late compatibility', async () => {
      const compatibility = Promise.withResolvers<unknown>()
      runtimeEnvironmentTransportCall.mockReturnValue(compatibility.promise)
      const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener')
      const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
      const loader = createLoader(surface, transport)
      loader.start()
      await vi.advanceTimersByTimeAsync(30_000)
      expectFailure(loader, surface, timeoutMessage)
      expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
      expect(mockApi.gh.prCheckDetails).not.toHaveBeenCalled()
      expect(mockApi.runtimeEnvironments.cancelSubscription).not.toHaveBeenCalled()
      expect(addListener.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1)
      expect(removeListener.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1)
      expect(removeListener).toHaveBeenCalledWith('abort', addListener.mock.calls[0]?.[1])
      compatibility.resolve(createCompatibleRuntimeStatusResponse())
      await vi.advanceTimersByTimeAsync(0)
      expect(runtimeEnvironmentTransportCall).toHaveBeenCalledOnce()
      expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
      expectFailure(loader, surface, timeoutMessage)
    })

    it.each([false, true])(
      'shares 20s + 10s and cleans up pending setup=%s',
      async (pendingSetup) => {
        const compatibility = Promise.withResolvers<unknown>()
        runtimeEnvironmentTransportCall.mockReturnValue(compatibility.promise)
        const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener')
        const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
        const subscription = recordRuntimeSubscription()
        const setup = Promise.withResolvers<{ unsubscribe: () => void }>()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        if (pendingSetup) {
          runtimeEnvironmentSubscribe.mockReturnValue(setup.promise)
        }
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(20_000)
        compatibility.resolve(createCompatibleRuntimeStatusResponse())
        await vi.advanceTimersByTimeAsync(0)
        expect(runtimeEnvironmentSubscribe).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(9_999)
        if (surface === 'store') {
          expect(loader.storeSettlement()).toBeUndefined()
        } else {
          expect(loader.state().detailsByCheckKey.check.loading).toBe(true)
        }
        await vi.advanceTimersByTimeAsync(1)
        expectFailure(loader, surface, timeoutMessage)
        if (pendingSetup) {
          expect(mockApi.runtimeEnvironments.cancelSubscription).toHaveBeenCalledWith({
            subscriptionId: expect.any(String)
          })
          expect(mockApi.runtimeEnvironments.cancelSubscription).toHaveBeenCalledOnce()
          expect(runtimeEnvironmentSubscribe.mock.calls[0]?.[0]).toMatchObject(
            mockApi.runtimeEnvironments.cancelSubscription.mock.calls[0]?.[0]
          )
          setup.resolve({ unsubscribe: subscription.unsubscribe })
          await vi.advanceTimersByTimeAsync(0)
        } else {
          expect(mockApi.runtimeEnvironments.cancelSubscription).not.toHaveBeenCalled()
          subscription.respond(successResponse())
        }
        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
        expect(addListener.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2)
        expect(removeListener.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2)
        expectRequestCounts(transport)
        expectFailure(loader, surface, timeoutMessage)
      }
    )
  })
}

for (const surface of ['dialog', 'page'] as const) {
  for (const transport of transports) {
    describe(`${surface} details request fences over ${transport}`, () => {
      it.each(['success', 'failure'] as const)(
        'keeps a newer result after an older %s',
        async (oldOutcome) => {
          const older = Promise.withResolvers<PRCheckRunDetails>()
          const newer = Promise.withResolvers<PRCheckRunDetails>()
          const oldSubscription = recordRuntimeSubscription()
          const newSubscription = recordRuntimeSubscription()
          runtimeEnvironmentSubscribe
            .mockImplementationOnce(oldSubscription.subscribe)
            .mockImplementationOnce(newSubscription.subscribe)
          mockApi.gh.prCheckDetails
            .mockReturnValueOnce(older.promise)
            .mockReturnValueOnce(newer.promise)
          const loader = createLoader(surface, transport)
          loader.start()
          await vi.advanceTimersByTimeAsync(0)
          loader.start()
          await vi.advanceTimersByTimeAsync(0)
          const newerDetails = {
            ...details,
            title: 'Newer request',
            jobs: [checkLogJob(legacyControls)]
          }
          newer.resolve(newerDetails)
          if (transport === 'rpc') {
            newSubscription.respond(successResponse(newerDetails))
          }
          await vi.advanceTimersByTimeAsync(0)
          const current = loader.state()
          expect(current.detailsByCheckKey.check).toEqual({
            requestId: 2,
            loading: false,
            details: {
              ...newerDetails,
              jobs: [{ ...newerDetails.jobs[0], logTail: expectedLegacyControls }]
            },
            error: null
          })
          if (oldOutcome === 'success') {
            older.resolve(details)
            if (transport === 'rpc') {
              oldSubscription.respond(successResponse())
            }
          } else if (transport === 'ipc') {
            older.reject(hostileError())
          } else {
            oldSubscription
              .callbacks()
              .onError?.({ code: 'runtime_error', message: 'SYNTHETIC_SECRET_old' })
          }
          await vi.advanceTimersByTimeAsync(0)
          expect(loader.state()).toBe(current)
          expect(normalization.normalizeCheckRunDetailsLogTails).toHaveBeenCalledTimes(
            oldOutcome === 'success' ? 2 : 1
          )
          expect(sanitation.sanitizeCheckJobLogExcerpt).toHaveBeenCalledExactlyOnceWith(
            legacyControls
          )
          expectRequestCounts(transport, 2)
          expect(vi.getTimerCount()).toBe(0)
        }
      )

      it.each([
        ['context', 'success'],
        ['context', 'failure'],
        ['unmount', 'success'],
        ['unmount', 'failure']
      ] as const)('ignores %s replacement followed by %s', async (fence, outcome) => {
        const upstream = Promise.withResolvers<PRCheckRunDetails>()
        const subscription = recordRuntimeSubscription()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        mockApi.gh.prCheckDetails.mockReturnValue(upstream.promise)
        const loader = createLoader(surface, transport)
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        if (fence === 'context') {
          loader.replaceContext()
        } else {
          loader.ctx.mountedRef.current = false
        }
        const current = loader.state()
        const rawDetails = { ...details, jobs: [checkLogJob(legacyControls)] }
        if (transport === 'ipc') {
          if (outcome === 'success') {
            upstream.resolve(rawDetails)
          } else {
            upstream.reject(hostileError())
          }
        } else if (outcome === 'success') {
          subscription.respond(successResponse(rawDetails))
        } else {
          subscription
            .callbacks()
            .onError?.({ code: 'runtime_error', message: 'SYNTHETIC_SECRET_old' })
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(loader.state()).toBe(current)
        expect(normalization.normalizeCheckRunDetailsLogTails).toHaveBeenCalledTimes(
          outcome === 'success' ? 1 : 0
        )
        expect(sanitation.sanitizeCheckJobLogExcerpt).toHaveBeenCalledTimes(
          outcome === 'success' ? 1 : 0
        )
        expectRequestCounts(transport)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('starts no request without repository context or check handles', async () => {
        const loader = createLoader(surface, transport)
        loader.ctx.canUseChecksRepoContext = false
        loader.start()
        loader.ctx.canUseChecksRepoContext = true
        loader.start({ name: 'no handle', status: 'queued', conclusion: null, url: null })
        await vi.advanceTimersByTimeAsync(0)
        expect(loader.ctx.nextCheckDetailsRequestIdRef.current).toBe(0)
        expect(loader.state().detailsByCheckKey).toEqual({})
        expect(mockApi.gh.prCheckDetails).not.toHaveBeenCalled()
        expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
        expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      })
    })
  }
}

it.each([false, true])(
  'keeps folder repo owner routing with remote focused (remote=%s)',
  async (remote) => {
    const loader = createLoader('store', remote ? 'rpc' : 'ipc')
    loader.ctx.sourceContext = null
    loader.store.setState({
      repos: [
        {
          id: 'caller-repo',
          path: '/folder',
          displayName: 'Folder',
          badgeColor: '',
          addedAt: 1,
          kind: 'folder',
          executionHostId: remote ? 'runtime:folder-owner' : undefined
        }
      ]
    })
    const subscription = recordRuntimeSubscription()
    runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
    mockApi.gh.prCheckDetails.mockResolvedValue(details)
    loader.start()
    await vi.advanceTimersByTimeAsync(0)
    if (remote) {
      expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'folder-owner',
          params: expect.objectContaining({ repo: 'caller-repo' })
        }),
        expect.any(Object)
      )
      subscription.respond(successResponse())
    } else {
      expect(mockApi.gh.prCheckDetails).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/folder', repoId: 'caller-repo', sourceContext: null })
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(loader.storeSettlement()).toEqual({ status: 'fulfilled', details })
    expectRequestCounts(remote ? 'rpc' : 'ipc')
    expect(vi.getTimerCount()).toBe(0)
  }
)
