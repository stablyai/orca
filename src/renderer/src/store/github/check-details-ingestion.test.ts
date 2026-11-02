import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as normalization from '@/lib/check-run-details-log-normalization'
import * as sanitation from '../../../../shared/check-job-log-excerpt'
import * as ansi from '../../../../shared/ansi-escape-sequences'
import {
  captured,
  checkLogDetails,
  checkLogJob,
  expectedLegacyControls,
  mixedCheckLogDetails
} from '@/lib/check-run-details-log-normalization-test-fixture'
import { recordRuntimeSubscription } from '@/runtime/runtime-environment-bridge-fixture'
import {
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentSubscribe,
  runtimeEnvironmentTransportCall
} from '../slices/github-slice-test-harness'
import {
  createLoader,
  surfaces,
  transports,
  successResponse,
  expectRequestCounts,
  type Surface
} from './check-details-loader-test-fixture'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const localRuntimeCall = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  resetRemoteRuntimeMocks()
  mockApi.gh.prCheckDetails.mockReset()
  Object.assign(window.api, { runtime: { call: localRuntimeCall } })
  vi.spyOn(normalization, 'normalizeCheckRunDetailsLogTails')
  vi.spyOn(sanitation, 'sanitizeCheckJobLogExcerpt')
  vi.spyOn(ansi, 'stripAnsiEscapeSequences')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function loadedDetails(loader: ReturnType<typeof createLoader>, surface: Surface) {
  if (surface !== 'store') {
    return loader.state().detailsByCheckKey.check.details
  }
  const settlement = loader.storeSettlement()
  if (settlement?.status !== 'fulfilled') {
    throw new Error('Expected fulfilled details')
  }
  return settlement.details
}

const cases = [
  'mixed',
  'oversized malformed',
  'cut boundary',
  'empty jobs',
  'null tails',
  'null details'
] as const
function incomingDetails(kind: (typeof cases)[number]) {
  if (kind === 'null details') {
    return null
  }
  if (kind === 'mixed') {
    return mixedCheckLogDetails()
  }
  if (kind === 'empty jobs') {
    return checkLogDetails([])
  }
  if (kind === 'null tails') {
    return checkLogDetails([checkLogJob(null)])
  }
  const tail =
    kind === 'cut boundary'
      ? `${'漢😀'.repeat(50_000)}\x1b[31m${'x'.repeat(16_380)}`
      : `${'漢😀'.repeat(300_000)}${'\x1b]x\x1bPx\x1b_x\x1b^x\x1bXx\x9dx\x90x\x98x\x9ex\x9fx'.repeat(900)}\r\n\x1b[31mEr\x1b[0mror: boundary\r\tat file.ts:18:8\n`
  return checkLogDetails([checkLogJob(tail)])
}

for (const surface of surfaces) {
  for (const transport of transports) {
    describe(`${surface}/${transport} real check log ingress`, () => {
      it.each(cases)(
        'normalizes %s once after resolution with original-value API calls',
        async (kind) => {
          const raw = incomingDetails(kind)
          const snapshot = JSON.stringify(raw)
          const subscription = recordRuntimeSubscription()
          const response = Promise.withResolvers<typeof raw>()
          runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
          mockApi.gh.prCheckDetails.mockReturnValue(response.promise)
          const loader = createLoader(surface, transport)
          loader.start()
          await vi.advanceTimersByTimeAsync(0)
          expect(normalization.normalizeCheckRunDetailsLogTails).not.toHaveBeenCalled()
          response.resolve(raw)
          if (transport === 'rpc') {
            subscription.respond(successResponse(raw))
          }
          await vi.advanceTimersByTimeAsync(0)
          const result = loadedDetails(loader, surface)
          expect(normalization.normalizeCheckRunDetailsLogTails).toHaveBeenCalledExactlyOnceWith(
            raw
          )
          const rawTails =
            raw?.jobs.flatMap((job) => (typeof job.logTail === 'string' ? [job.logTail] : [])) ?? []
          expect(vi.mocked(sanitation.sanitizeCheckJobLogExcerpt).mock.calls).toEqual(
            rawTails.map((tail) => [tail])
          )
          const retainedViews = vi
            .mocked(ansi.stripAnsiEscapeSequences)
            .mock.calls.map(([view]) => view)
          expect(retainedViews).toHaveLength(rawTails.length)
          for (const view of retainedViews) {
            expect(new TextEncoder().encode(view).length).toBeLessThanOrEqual(16_384)
          }
          if (!raw) {
            expect(result).toBeNull()
          } else {
            if (!result) {
              throw new Error('Expected loaded details')
            }
            expect(result.annotations).toBe(raw.annotations)
            expect({ ...result, jobs: raw.jobs }).toEqual(raw)
            for (const [i, job] of result.jobs.entries()) {
              expect(job.steps).toBe(raw.jobs[i].steps)
              expect({ ...job, logTail: raw.jobs[i].logTail }).toEqual(raw.jobs[i])
              expect(Object.hasOwn(job, 'logState')).toBe(Object.hasOwn(raw.jobs[i], 'logState'))
              expect(job === raw.jobs[i]).toBe(raw.jobs[i].logTail === null)
              if (job.logTail !== null) {
                expect(new TextEncoder().encode(job.logTail).length).toBeLessThanOrEqual(16_384)
                expect(
                  [...job.logTail].every((character) => {
                    const unit = character.charCodeAt(0)
                    return unit === 9 || unit === 10 || (unit >= 32 && (unit < 127 || unit > 159))
                  })
                ).toBe(true)
                expect(job.logTail).not.toMatch(
                  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u
                )
              }
            }
            if (kind === 'mixed') {
              expect(result.jobs[0].logTail).toBe(expectedLegacyControls)
              expect(result.jobs[1].logTail).toContain(captured.expectedDiagnostic)
              expect(result.jobs[1].logTail).toContain(captured.expectedStackFrame)
              expect(result.jobs.map((job) => job.logState)).toEqual([
                undefined,
                'available',
                'empty',
                'error',
                'not_requested',
                undefined
              ])
            } else if (kind === 'cut boundary') {
              expect(result.jobs[0].logTail).toBe(`[31m${'x'.repeat(16_380)}`)
            } else if (kind === 'oversized malformed') {
              expect(result.jobs[0].logTail).toMatch(/\nError: boundary\n\tat file.ts:18:8\n$/)
              expect(new TextEncoder().encode(rawTails[0]).length).toBeGreaterThan(16_384)
            }
          }
          expect(JSON.stringify(raw)).toBe(snapshot)
          expectRequestCounts(transport)
          expect(localRuntimeCall).not.toHaveBeenCalled()
          expect(vi.getTimerCount()).toBe(0)
          if (transport === 'rpc') {
            expect(subscription.unsubscribe).toHaveBeenCalledOnce()
          }
        }
      )
    })
  }
}

for (const surface of surfaces) {
  describe(`${surface} paired RPC failure boundary`, () => {
    it.each([
      'envelope failure',
      'disconnect',
      'transport error',
      'compatibility failure'
    ] as const)(
      'does not execute locally or normalize after %s or a late frame',
      async (failure) => {
        const subscription = recordRuntimeSubscription()
        runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
        if (failure === 'compatibility failure') {
          runtimeEnvironmentTransportCall.mockRejectedValue(
            new Error('SYNTHETIC_SECRET_compatibility')
          )
        }
        const loader = createLoader(surface, 'rpc')
        const warnings = vi.spyOn(console, 'warn')
        const errors = vi.spyOn(console, 'error')
        loader.start()
        await vi.advanceTimersByTimeAsync(0)
        if (failure === 'disconnect') {
          subscription.callbacks().onClose?.()
        }
        if (failure === 'transport error') {
          subscription
            .callbacks()
            .onError?.({ code: 'runtime_error', message: 'SYNTHETIC_SECRET_transport' })
        }
        if (failure === 'envelope failure') {
          subscription.respond({
            id: 'failure',
            ok: false,
            error: { code: 'runtime_error', message: 'SYNTHETIC_SECRET_response' }
          })
        }
        await vi.advanceTimersByTimeAsync(0)
        const settledStore = loader.storeSettlement()
        const settledState = loader.state()
        if (surface === 'store') {
          expect(settledStore?.status).toBe('rejected')
          if (settledStore?.status !== 'rejected' || !(settledStore.error instanceof Error)) {
            throw new Error('Expected rejected Error')
          }
          expect(settledStore.error.message).toBe('Failed to load check details.')
        } else {
          expect(settledState.detailsByCheckKey.check).toMatchObject({
            loading: false,
            details: null,
            error: 'Failed to load check details.'
          })
        }
        if (failure !== 'compatibility failure') {
          subscription.respond(successResponse(mixedCheckLogDetails()))
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(loader.storeSettlement()).toBe(settledStore)
        expect(loader.state()).toBe(settledState)
        expect(normalization.normalizeCheckRunDetailsLogTails).not.toHaveBeenCalled()
        expect(sanitation.sanitizeCheckJobLogExcerpt).not.toHaveBeenCalled()
        expect(mockApi.gh.prCheckDetails).not.toHaveBeenCalled()
        expect(localRuntimeCall).not.toHaveBeenCalled()
        expect(runtimeEnvironmentTransportCall.mock.calls.map(([args]) => args.method)).toEqual([
          'status.get'
        ])
        expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(
          failure === 'compatibility failure' ? 0 : 1
        )
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(
          failure === 'compatibility failure' ? 0 : 1
        )
        expect(warnings).not.toHaveBeenCalled()
        expect(errors).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      }
    )
  })
}
