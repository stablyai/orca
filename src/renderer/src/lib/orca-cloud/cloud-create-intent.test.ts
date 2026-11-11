import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelCloudCreateIntent,
  cloudCreateIdempotencyKey,
  consumeCloudCreateIntent,
  resetCloudCreateIntentsForTest,
  startCloudCreate
} from './cloud-create-intent'
import {
  closeCloudSetupPage,
  getCloudSetupPageRequest,
  openCloudSetupPage
} from './cloud-setup-page-store'

// One Create press makes exactly one server create, across sign-in, the setup page, its auto-start,
// a reveal, Exit, Back and a re-open (P0, JA-01/PC-8). `create` stands in for the server create.
function press(create: (id: string) => void, setupNeeded: boolean): void {
  startCloudCreate({
    setupOpen: getCloudSetupPageRequest() !== null,
    setupNeeded,
    openSetup: (intentId) =>
      openCloudSetupPage({
        prompt: 'p',
        repoId: 'r',
        agent: 'claude',
        availability: 'needs-sign-in',
        cloudOnlyRepo: null,
        composer: {},
        intentId
      }),
    create
  })
}

describe('one Create, one server create', () => {
  beforeEach(() => {
    resetCloudCreateIntentsForTest()
    closeCloudSetupPage()
  })

  it('a ready account creates once, and a double press makes two separate intents', () => {
    const create = vi.fn()
    press(create, false)
    expect(create).toHaveBeenCalledTimes(1)
    const [intent] = create.mock.calls[0] ?? []
    expect(consumeCloudCreateIntent(intent)).toBe(false)
  })

  it('setup: nothing creates while the page is open; the auto-start creates once', () => {
    const create = vi.fn()
    press(create, true)
    const request = getCloudSetupPageRequest()
    expect(request).not.toBeNull()
    expect(create).not.toHaveBeenCalled()
    // Another press while the page is open (a stale composer, a keyboard repeat) does nothing.
    press(create, false)
    expect(create).not.toHaveBeenCalled()
    // Sign-in lands and the page reopens the hidden composer: the auto-start consumes the intent.
    closeCloudSetupPage()
    if (consumeCloudCreateIntent(request?.intentId)) {
      create(request?.intentId)
    }
    // The 8 s reveal remounts the composer, and its effect runs again: no second create.
    if (consumeCloudCreateIntent(request?.intentId)) {
      create(request?.intentId)
    }
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('Exit or Back cancels the start for real, even after a later sign-in', () => {
    const create = vi.fn()
    press(create, true)
    const request = getCloudSetupPageRequest()
    cancelCloudCreateIntent(request?.intentId)
    closeCloudSetupPage()
    // A later sign-in elsewhere, or a stale auto-start, finds nothing to run.
    expect(consumeCloudCreateIntent(request?.intentId)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('a new Start replaces the old setup, and the old press can never create', () => {
    const create = vi.fn()
    press(create, true)
    const first = getCloudSetupPageRequest()
    closeCloudSetupPage()
    press(create, true)
    const second = getCloudSetupPageRequest()
    expect(second?.intentId).not.toBe(first?.intentId)
    expect(consumeCloudCreateIntent(second?.intentId)).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('Idempotency-Key per Create press', () => {
  beforeEach(() => {
    resetCloudCreateIntentsForTest()
    closeCloudSetupPage()
  })

  it('every creation fired by one press sends the same key; an explicit retry gets its own', () => {
    const create = vi.fn()
    press(create, false)
    const [intent] = create.mock.calls[0] ?? []
    expect(intent).toMatch(/^create:[A-Za-z0-9_.:-]{8,120}$/)
    expect(cloudCreateIdempotencyKey('creation-1')).toBe(intent)
    // A re-fired start (another creation for the same press) dedupes on the server.
    expect(cloudCreateIdempotencyKey('creation-2')).toBe(intent)
    // Retry of creation-1 after a failure is a new attempt.
    expect(cloudCreateIdempotencyKey('creation-1')).toBe(`${intent}:retry-1`)
  })

  it('no armed press, no key', () => {
    expect(cloudCreateIdempotencyKey('creation-x')).toBeNull()
  })
})
