// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import { ensureWorkspaceTrustConfirmed } from './ensure-workspace-trust-confirmed'

type ResolveIntakeMockResult = Awaited<ReturnType<Window['api']['workspaceTrust']['resolveIntake']>>

function stubApi(resolveIntakeResult: ResolveIntakeMockResult | undefined): {
  resolveIntake: ReturnType<typeof vi.fn>
  decide: ReturnType<typeof vi.fn>
} {
  const resolveIntake = vi.fn(() => Promise.resolve(resolveIntakeResult))
  const decide = vi.fn(() => Promise.resolve(null))
  Object.assign(window, { api: { workspaceTrust: { resolveIntake, decide } } })
  return { resolveIntake, decide }
}

function fakeState(): { openModal: ReturnType<typeof vi.fn> } {
  return { openModal: vi.fn() }
}

const target = { kind: 'repo' as const, repoId: 'repo-1' }
const path = '/home/user/work/proj'

describe('ensureWorkspaceTrustConfirmed', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when the outcome inherits trust silently', async () => {
    const { decide } = stubApi({ outcome: 'inherit-trusted', inheritedFrom: '/home/user/work' })
    const state = fakeState()

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(state.openModal).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('does nothing when the outcome is already-declined', async () => {
    const { decide } = stubApi({ outcome: 'already-declined', declinedEntryId: 'entry-1' })
    const state = fakeState()

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(state.openModal).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('does nothing when the outcome is not-applicable', async () => {
    const { decide } = stubApi({ outcome: 'not-applicable' })
    const state = fakeState()

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(state.openModal).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('tolerates an undefined resolveIntake result (web fallback) without throwing', async () => {
    const { decide } = stubApi(undefined)
    const state = fakeState()

    await expect(
      ensureWorkspaceTrustConfirmed(state as never, target, path)
    ).resolves.toBeUndefined()

    expect(state.openModal).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('opens the prompt with the exact path and records a workspace-scoped trust on confirm', async () => {
    const { decide } = stubApi({ outcome: 'prompt', reason: 'no-decision' })
    const state = fakeState()
    state.openModal.mockImplementation((_modal: string, data: Record<string, unknown>) => {
      ;(data.onResolve as (decision: string) => void)('trust-workspace')
    })

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(state.openModal).toHaveBeenCalledWith(
      'confirm-workspace-trust',
      expect.objectContaining({ path })
    )
    expect(decide).toHaveBeenCalledWith({ target, scope: 'workspace', decision: 'trust' })
  })

  it('records a parent-scoped trust when the user picks the parent alternative', async () => {
    const { decide } = stubApi({ outcome: 'prompt', reason: 'no-decision' })
    const state = fakeState()
    state.openModal.mockImplementation((_modal: string, data: Record<string, unknown>) => {
      ;(data.onResolve as (decision: string) => void)('trust-parent')
    })

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(decide).toHaveBeenCalledWith({ target, scope: 'parent', decision: 'trust' })
  })

  it('persists a decline decision on the exact path, never suppressing it', async () => {
    const { decide } = stubApi({
      outcome: 'prompt',
      reason: 'ancestor-declined',
      ancestorPath: '/home'
    })
    const state = fakeState()
    state.openModal.mockImplementation((_modal: string, data: Record<string, unknown>) => {
      ;(data.onResolve as (decision: string) => void)('decline')
    })

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(decide).toHaveBeenCalledWith({ target, scope: 'workspace', decision: 'decline' })
  })

  it('settles as a decline when the singleton modal slot evicts this prompt', async () => {
    const { decide } = stubApi({ outcome: 'prompt', reason: 'no-decision' })
    const state = fakeState()
    state.openModal.mockImplementation((_modal: string, data: Record<string, unknown>) => {
      ;(data[MODAL_DISMISSED_KEY] as () => void)()
    })

    await ensureWorkspaceTrustConfirmed(state as never, target, path)

    expect(decide).toHaveBeenCalledWith({ target, scope: 'workspace', decision: 'decline' })
  })
})
