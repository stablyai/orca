import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { moveTerminalTabIntoPane } from './terminal-tab-into-pane-move'
import { createJoinHarness, mainSessionAfterJoin } from './terminal-tab-into-pane-move-harness'
import { isTerminalTabMoveInFlight } from './terminal-leaf-move-guard'
import { A, P_A, SOURCE, TARGET, WT } from './terminal-tab-into-pane-fixture'

// The window-applied join under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

const mockApi = createStoreCascadesMockApi()
Object.assign(mockApi, { session: { closeTerminalSurface: vi.fn().mockResolvedValue(undefined) } })

const join = { sourceTabId: SOURCE, targetTabId: TARGET, side: 'right' } as const

beforeEach(() => {
  vi.clearAllMocks()
})

function expectNothingApplied(h: ReturnType<typeof createJoinHarness>): void {
  expect(h.calls).toEqual([])
  expect(h.splits).toEqual([])
  const state = h.store.getState()
  expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([SOURCE, TARGET])
  expect(state.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBeUndefined()
  expect(mockApi.pty.kill).not.toHaveBeenCalled()
}

describe('moveTerminalTabIntoPane results', () => {
  it('not_held is a refusal: nothing is applied here, and the user is told', async () => {
    const h = createJoinHarness(createTestStore())
    h.answerWith(() => Promise.resolve({ status: 'not_held' }))

    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('refused')

    expectNothingApplied(h)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('a main refusal applies nothing and tells the user', async () => {
    const h = createJoinHarness(createTestStore())
    h.answerWith(() => Promise.resolve({ status: 'refused', reason: 'source_not_single_leaf' }))

    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('refused')

    expectNothingApplied(h)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('a renderer-side ineligible move never reaches main', async () => {
    const h = createJoinHarness(createTestStore())
    h.store.setState({ unverifiedPtyLossTabIds: { [SOURCE]: true } })

    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('refused')

    expect(h.requests).toEqual([])
    expectNothingApplied(h)
  })

  describe('an IPC call that rejects is unknown, not a refusal', () => {
    it('applies the join when main reports the leaf now lives in the target', async () => {
      const h = createJoinHarness(createTestStore(), {
        readMainSession: () => Promise.resolve(mainSessionAfterJoin())
      })
      h.answerWith(() => Promise.reject(new Error('channel closed')))

      await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('moved')

      expect(h.store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TARGET])
      expect(h.store.getState().terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe(P_A)
      expect(h.splits).toHaveLength(1)
    })

    it('applies nothing and reports unknown when main still holds the leaf in the source', async () => {
      const h = createJoinHarness(createTestStore())
      h.deps.readMainSession = () =>
        Promise.resolve({ terminalLayoutsByTabId: h.store.getState().terminalLayoutsByTabId })
      h.answerWith(() => Promise.reject(new Error('channel closed')))

      await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('unknown')

      expectNothingApplied(h)
    })

    it('applies nothing and reports unknown when main cannot be read either', async () => {
      const h = createJoinHarness(createTestStore(), {
        readMainSession: () => Promise.reject(new Error('gone'))
      })
      h.answerWith(() => Promise.reject(new Error('channel closed')))

      await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('unknown')

      expectNothingApplied(h)
    })
  })

  describe('a move main committed but this window cannot finish applying', () => {
    it('an apply that throws is reported, the target remounts from its stored layout, nothing escapes', async () => {
      const h = createJoinHarness(createTestStore(), {
        dispatchSplit: () => {
          throw new Error('split handler blew up')
        }
      })

      await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('unknown')

      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(h.calls).toContain(`remount:${TARGET}`)
      expect(isTerminalTabMoveInFlight(TARGET)).toBe(false)
    })

    it('a target whose layout left this window during the call still closes the source, without a kill', async () => {
      const h = createJoinHarness(createTestStore())
      h.answerWith(() => {
        h.store.setState((s) => {
          const { [TARGET]: _gone, ...others } = s.terminalLayoutsByTabId
          return { terminalLayoutsByTabId: others }
        })
        return Promise.resolve({ status: 'moved', ptyId: P_A, sourceTabClosed: true })
      })

      await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('unknown')

      expect(toast.error).toHaveBeenCalledTimes(1)
      const state = h.store.getState()
      expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).not.toContain(SOURCE)
      expect(state.terminalLayoutsByTabId[SOURCE]).toBeUndefined()
      expect(mockApi.pty.kill).not.toHaveBeenCalled()
      expect(h.splits).toEqual([])
    })
  })

  describe('the in-flight guard', () => {
    it('refuses a second move of the same leaf while the first awaits main, then releases', async () => {
      const h = createJoinHarness(createTestStore())
      let finish: (() => void) | undefined
      h.answerWith(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ status: 'moved', ptyId: P_A, sourceTabClosed: true })
          })
      )

      const first = moveTerminalTabIntoPane(join, h.deps)
      expect(isTerminalTabMoveInFlight(TARGET)).toBe(true)
      await expect(moveTerminalTabIntoPane({ ...join, side: 'left' }, h.deps)).resolves.toBe(
        'refused'
      )
      expect(h.requests).toHaveLength(1)

      finish?.()
      await expect(first).resolves.toBe('moved')
      expect(isTerminalTabMoveInFlight(TARGET)).toBe(false)
    })

    it('releases after a refusal and after an unknown result', async () => {
      const h = createJoinHarness(createTestStore())
      h.answerWith(() => Promise.resolve({ status: 'not_held' }))
      await moveTerminalTabIntoPane(join, h.deps)
      expect(isTerminalTabMoveInFlight(SOURCE)).toBe(false)

      h.answerWith(() => Promise.reject(new Error('x')))
      await moveTerminalTabIntoPane(join, h.deps)
      expect(isTerminalTabMoveInFlight(SOURCE)).toBe(false)
    })
  })
})
