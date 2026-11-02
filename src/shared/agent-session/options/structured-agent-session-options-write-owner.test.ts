import { describe, expect, it, vi } from 'vitest'
import { cloneStructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionShownSnapshot
} from './structured-agent-session-option-view'
import { createStructuredAgentSessionOptionState } from './structured-agent-session-options'
import {
  acceptedStructuredSessionSelectionOutcome,
  createStructuredAgentSessionOptionsWriteOwner
} from './structured-agent-session-options-write-owner'
import {
  createStructuredSessionSelectionController,
  type SelectionOutcome
} from './structured-agent-session-selection-operations'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'

function harness(agent = 'codex') {
  let state = {
    ...createStructuredAgentSessionOptionState(agent, {
      ...structuredAgentSessionSeedCatalog(agent),
      models: []
    }),
    permissionMode: 'ask',
    reportedPermissionMode: 'ask',
    permissionOwnSupported: true
  }
  let controller = createStructuredSessionSelectionController(vi.fn())
  let starting = false
  let visit = {}
  const replies: ReturnType<typeof Promise.withResolvers<SelectionOutcome>>[] = []
  const sends = vi.fn(() => {
    const reply = Promise.withResolvers<SelectionOutcome>()
    replies.push(reply)
    return reply.promise
  })
  const revalidate = vi.fn()
  const presentFailure = vi.fn()
  const writer = createStructuredAgentSessionOptionsWriteOwner(() => {
    const view = structuredAgentSessionOptionView(state, undefined, controller.overlay())
    return {
      controller,
      record: state.record,
      view,
      snapshot: structuredAgentSessionShownSnapshot(view),
      ready: true,
      providerStarting: starting,
      isCurrentContext: () => true,
      flush: () => controller.flush(sends),
      capturePresentation: () => {
        const captured = visit
        return () => captured === visit
      },
      revalidate,
      presentFailure,
      revalidateOn: 'refused-current'
    }
  })
  return {
    writer,
    sends,
    revalidate,
    presentFailure,
    pending: () => writer.pendingOptionId(controller, state.record),
    controller: () => controller,
    starting: (value: boolean) => {
      starting = value
    },
    reset: () => {
      state = { ...state, record: cloneStructuredAgentSessionOptionRecord(state.record) }
    },
    endPresentation: () => {
      visit = {}
    },
    replaceController: () => {
      controller = createStructuredSessionSelectionController(vi.fn())
    },
    settle: (index: number, outcome: SelectionOutcome) => replies[index]!.resolve(outcome)
  }
}

const accepted = { kind: 'accepted', options: {} } as const

describe('shared option write transaction', () => {
  it.each(['claude', 'codex'])(
    'admits literal %s picks with no listed models and retains only finite overlays',
    async (agent) => {
      const h = harness(agent)
      const controller = h.controller()
      const observed: (string | null)[] = []
      const unsubscribe = controller.subscribe(() => observed.push(h.pending()))
      const model = h.writer.setOption('model', 'unlisted-alias')
      expect(controller.overlay()).toEqual({ model: 'unlisted-alias' })
      expect(observed[0]).toBe('model')
      expect(await h.writer.setOption('model', 'another-alias')).toBe(false)
      const effort = h.writer.setOption('effort', 'unlisted-effort')
      const fast = h.writer.setOption('fastMode', true)
      expect(h.sends).toHaveBeenCalledTimes(3)
      expect(controller.overlay()).toEqual({
        model: 'unlisted-alias',
        effort: 'unlisted-effort',
        fastMode: 'true'
      })
      h.settle(
        0,
        acceptedStructuredSessionSelectionOutcome({ key: 'model', value: 'unlisted-alias' })
      )
      h.settle(1, { kind: 'refused' })
      h.settle(2, { kind: 'unknown' })
      expect(await Promise.all([model, effort, fast])).toEqual([true, false, true])
      expect(h.pending()).toBeNull()
      expect(controller.overlay()).toEqual({ model: 'unlisted-alias', fastMode: 'true' })
      const captured = controller.captureRead()
      expect(captured).toHaveLength(2)
      // A read retires only its captured terminal identities when it publishes.
      controller.retire([])
      expect(controller.overlay().model).toBe('unlisted-alias')
      controller.retire(captured)
      expect(controller.overlay()).toEqual({})
      expect(h.revalidate).toHaveBeenCalledTimes(1)
      unsubscribe()
    }
  )

  it.each([true, false])(
    'keeps the issue-time startup policy across a phase change: starting=%s',
    async (starting) => {
      const h = harness()
      h.starting(starting)
      const picking = h.writer.setOption('model', 'literal')
      expect(h.pending()).toBe(starting ? null : 'model')
      h.starting(!starting)
      expect(h.pending()).toBe(starting ? null : 'model')
      if (starting) {
        // The sheet is free, but ordinary same-key admission still consults the controller.
        expect(await h.writer.setOption('model', 'different-string')).toBe(false)
        const effort = h.writer.setOption('effort', 'high')
        expect(h.pending()).toBe('effort')
        h.settle(1, accepted)
        await effort
        expect(h.pending()).toBeNull()
      }
      h.settle(0, accepted)
      await picking
      expect(h.pending()).toBeNull()
    }
  )

  it.each([
    { second: 'fastMode', value: true, order: [0, 1] },
    { second: 'fastMode', value: true, order: [1, 0] },
    { second: 'permissionMode', value: 'full-access', order: [1, 0] }
  ])('never falls back to an earlier key: $second / $order', async ({ second, value, order }) => {
    const h = harness()
    const first = h.writer.setOption('model', 'literal')
    const latest = h.writer.setOption(second, value)
    expect(h.pending()).toBe(second === 'permissionMode' ? null : second)
    const picks = [first, latest]
    const completed = new Set<number>()
    for (const index of order) {
      h.settle(index, accepted)
      await picks[index]
      completed.add(index)
      expect(h.pending()).toBe(second === 'permissionMode' || completed.has(1) ? null : second)
    }
  })

  it('keeps startup and permission repicks free across reverse replies and startup ending', async () => {
    const h = harness()
    h.starting(true)
    const first = h.writer.setOption('model', 'first')
    const second = h.writer.setOption('model', 'second')
    h.starting(false)
    expect(h.pending()).toBeNull()
    const permission = h.writer.setOption('permissionMode', 'full-access')
    const repick = h.writer.setOption('permissionMode', 'ask')
    h.settle(3, accepted)
    h.settle(1, accepted)
    await Promise.all([repick, second])
    expect(h.pending()).toBeNull()
    expect(h.controller().overlay()).toMatchObject({ model: 'second', permissionMode: 'ask' })
    h.settle(2, accepted)
    h.settle(0, accepted)
    await Promise.all([permission, first])
    expect(h.pending()).toBeNull()
  })

  it.each([
    'same-record read',
    'record reset',
    'controller replacement',
    'detach',
    'abandon',
    'presentation ends'
  ])(
    'scopes pending to the record and late presentation to its scope across %s',
    async (change) => {
      const h = harness()
      const picking = h.writer.setOption('model', 'literal')
      if (change === 'record reset') {
        h.reset()
      }
      if (change === 'controller replacement') {
        h.replaceController()
      }
      if (change === 'detach') {
        h.writer.detach()
      }
      if (change === 'abandon') {
        h.controller().abandon()
      }
      if (change === 'presentation ends') {
        h.endPresentation()
      }
      expect(h.pending()).toBe(
        change === 'same-record read' || change === 'presentation ends' ? 'model' : null
      )
      h.settle(0, { kind: 'refused', failure: { kind: 'unconfirmed' } })
      await picking
      expect(h.pending()).toBeNull()
      expect(h.presentFailure).toHaveBeenCalledTimes(
        change === 'abandon' || change === 'presentation ends' ? 0 : 1
      )
      expect(h.revalidate).toHaveBeenCalledTimes(
        change === 'same-record read' || change === 'presentation ends' ? 1 : 0
      )
    }
  )
})
