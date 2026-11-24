import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../background-tasks/agent-session-background-task-wire'
import type { AgentChildWorkView } from '../../../agent-status/child-work/agent-status-child-work-view'
import {
  createCommandDetailAuthority,
  type CommandDetailCreditScope
} from './command-detail-authority'

const TUPLE = { childWorkId: 'cmd', invocationId: 'cmd-run', generation: 1 }
const OTHER = { childWorkId: 'other', invocationId: 'other-run', generation: 1 }

function child(tuple: typeof TUPLE): AgentChildWorkView {
  return {
    id: tuple.childWorkId,
    kind: 'command',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: tuple.invocationId, generation: tuple.generation }
  }
}

function roster(available: (typeof TUPLE)[] = [TUPLE]): AgentSessionBackgroundTaskState {
  return {
    state: 'monitoring',
    children: [child(TUPLE), child(OTHER)],
    ...(available.length ? { commandDetailsAvailable: available } : {})
  }
}

function batch(
  sequence: number,
  options: { fence?: number; backgroundTasks?: AgentSessionBackgroundTaskState | null } = {},
  epoch = 'e1'
): AgentSessionSubscribeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    type: 'batch',
    sessionId: 's',
    batch: { cursor: { epoch, sequence }, items: [], removedItemIds: [], submissions: [] },
    ...options
  } as AgentSessionSubscribeEvent
}

function snapshot(
  sequence: number,
  fence: number,
  backgroundTasks?: AgentSessionBackgroundTaskState | null,
  type: 'snapshot' | 'reset' = 'snapshot',
  epoch = 'e1'
): AgentSessionSubscribeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    type,
    sessionId: 's',
    fence,
    ...(type === 'reset' ? { reset: 'epoch-changed' } : {}),
    page: { epoch, liveCursor: { epoch, sequence }, window: { nextCursor: null } },
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
  } as unknown as AgentSessionSubscribeEvent
}

/** One transport run, as the read owner wires it: open advances, then the sent cursor seeds. */
function run() {
  const authority = createCommandDetailAuthority()
  let transport = {}
  let generation = 0
  const scope = (): CommandDetailCreditScope => ({ transport, generation })
  const open = (
    cursor: { epoch: string; sequence: number } | null = { epoch: 'e1', sequence: 5 }
  ) => {
    generation += 1
    authority.invalidate(scope())
    authority.seed(scope(), cursor)
  }
  const restart = () => {
    authority.invalidate(null)
    transport = {}
    generation = 0
  }
  const deliver = (event: AgentSessionSubscribeEvent) => authority.observe(scope(), event)
  return { authority, open, restart, deliver, scope }
}

function credited(identity = { current: true }) {
  const read = run()
  read.open()
  read.deliver(batch(5, { fence: 7, backgroundTasks: roster() }))
  const opening = read.authority.open(TUPLE, () => identity.current)!
  let notified = 0
  opening.onLost(() => {
    notified += 1
  })
  return { ...read, opening, identity, notified: () => notified }
}

describe('command detail credit scope and loss (§R)', () => {
  it('grants only from an admitted roster on the current scope, and opens only listed tuples', () => {
    const read = run()
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
    read.open()
    read.deliver(batch(5, { fence: 7 }))
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
    read.deliver(batch(6, { fence: 7, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).not.toBeNull()
    expect(read.authority.open(OTHER, () => true)).toBeNull()
  })

  it('every open-generation advance loses openings synchronously; recovery needs a fresh opening', () => {
    const { authority, open, deliver, opening, notified } = credited()
    open()
    expect(opening.lost).toBe(true)
    expect(notified()).toBe(1)
    expect(authority.open(TUPLE, () => true)).toBeNull()
    // The identical tuple at the identical fence on the new scope.
    deliver(batch(5, { fence: 7, backgroundTasks: roster() }))
    expect(opening.valid()).toBe(false)
    expect(opening.check()).toBe(false)
    const fresh = authority.open(TUPLE, () => true)
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(opening)
  })

  it('contact loss and stop clear credit with a null scope; a late frame never regrants', () => {
    const { authority, deliver, opening, scope } = credited()
    const lateScope = scope()
    authority.invalidate(null)
    expect(opening.lost).toBe(true)
    authority.observe(lateScope, batch(6, { fence: 7, backgroundTasks: roster() }))
    deliver(batch(6, { fence: 7, backgroundTasks: roster() }))
    expect(authority.inspect().connected).toBe(false)
    expect(authority.open(TUPLE, () => true)).toBeNull()
  })

  it('a restarted run whose generation number repeats does not revive old credit', () => {
    const read = credited()
    const oldScope = read.scope()
    read.restart()
    read.open()
    // Same generation number as before, from the old transport instance.
    expect(read.scope().generation).toBe(oldScope.generation)
    read.authority.observe(oldScope, batch(6, { fence: 7, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
  })
})

describe('per-scope admission baseline and replacement order (A1-D8-01)', () => {
  it('hydrate then resume: the opening batch is admitted against the sent cursor and grants', () => {
    const read = run()
    read.open({ epoch: 'e1', sequence: 40 })
    read.deliver(batch(40, { fence: 3, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).not.toBeNull()
  })

  it('resync after admitted-but-uncommitted frames resumes from the committed cursor', () => {
    const read = run()
    read.open({ epoch: 'e1', sequence: 10 })
    // The previous run admitted up to 20, but the coalescer discarded them; the reducer holds 10.
    read.deliver(batch(20, { fence: 3 }))
    read.restart()
    read.open({ epoch: 'e1', sequence: 10 })
    read.deliver(batch(10, { fence: 3, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).not.toBeNull()
  })

  it('without the seed the opening batch grants nothing', () => {
    const read = run()
    read.authority.invalidate(read.scope())
    // A deleted seed: no baseline, so the batch is not admitted.
    read.deliver(batch(5, { fence: 3, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
  })

  it('a non-roster batch advances the mirrored cursor; an older roster batch is then rejected', () => {
    const read = run()
    read.open({ epoch: 'e1', sequence: 5 })
    read.deliver(batch(9, { fence: 3 }))
    read.deliver(batch(8, { fence: 3, backgroundTasks: roster() }))
    expect(read.authority.inspect().connected).toBe(false)
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
    read.deliver(batch(5, { fence: 3, backgroundTasks: roster() }, 'other-epoch'))
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
  })

  it.each(['snapshot', 'reset'] as const)(
    'a %s loses every opening, keeps the scope, then installs its own roster for fresh openings',
    (type) => {
      const { authority, deliver, opening, scope } = credited()
      const before = scope()
      deliver(snapshot(30, 7, roster(), type))
      expect(opening.lost).toBe(true)
      expect(authority.inspect().scope).toEqual(before)
      // The later stateGeneration bump and history invalidation do not touch the latch.
      expect(authority.open(TUPLE, () => true)).not.toBeNull()
      deliver(batch(30, { fence: 7 }))
      expect(authority.open(TUPLE, () => true)).not.toBeNull()
    }
  )

  it('a cursorless open is seeded by its opening snapshot', () => {
    const read = run()
    read.open(null)
    read.deliver(batch(1, { fence: 1, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).toBeNull()
    read.deliver(snapshot(4, 1, roster()))
    expect(read.authority.open(TUPLE, () => true)).not.toBeNull()
    read.deliver(batch(4, { fence: 1, backgroundTasks: roster() }))
    expect(read.authority.open(TUPLE, () => true)).not.toBeNull()
  })
})

describe('fence and roster admission (A1-D8-03)', () => {
  it('a non-snapshot roster at a moved fence loses the held opening and allows a fresh one', () => {
    const { authority, deliver, opening } = credited()
    deliver(batch(6, { fence: 8, backgroundTasks: roster() }))
    expect(opening.lost).toBe(true)
    const fresh = authority.open(TUPLE, () => true)
    expect(fresh?.fence).toBe(8)
  })

  it('unchanged-fence control: the same tuple at the same fence keeps the opening', () => {
    const { deliver, opening } = credited()
    deliver(batch(6, { fence: 7, backgroundTasks: roster() }))
    expect(opening.valid()).toBe(true)
  })

  it('defensive: a lower-fence non-snapshot roster loses the higher-fence opening', () => {
    const { authority, deliver, opening } = credited()
    deliver(batch(6, { fence: 6, backgroundTasks: roster() }))
    expect(opening.lost).toBe(true)
    // The latest admitted roster wins even with a lower fence.
    expect(authority.inspect().fence).toBe(6)
  })

  it('owed snapshot: a lower-fence snapshot installs its fresher roster after the loss', () => {
    const { authority, deliver, opening } = credited()
    deliver(snapshot(9, 6, roster([OTHER])))
    expect(opening.lost).toBe(true)
    expect(authority.open(OTHER, () => true)).not.toBeNull()
    expect(authority.open(TUPLE, () => true)).toBeNull()
  })

  it('an omitted tuple or a null roster loses the opening', () => {
    const omitted = credited()
    omitted.deliver(batch(6, { fence: 7, backgroundTasks: roster([OTHER]) }))
    expect(omitted.opening.lost).toBe(true)
    const cleared = credited()
    cleared.deliver(batch(6, { fence: 7, backgroundTasks: null }))
    expect(cleared.opening.lost).toBe(true)
    expect(cleared.authority.open(TUPLE, () => true)).toBeNull()
  })

  it('a live-text batch with a lagging acquisition fence changes neither credit nor openings', () => {
    const { authority, deliver, opening } = credited()
    deliver(batch(6, { fence: 2 }))
    expect(opening.valid()).toBe(true)
    expect(authority.inspect().fence).toBe(7)
    expect(authority.inspect().available.size).toBe(1)
  })
})

describe('visible refusal on a failed check (A1-D8-02)', () => {
  it('a pinned identity change latches the opening lost and notifies at the check', () => {
    const { opening, identity, notified } = credited()
    expect(opening.check()).toBe(true)
    identity.current = false
    expect(opening.check()).toBe(false)
    expect(opening.lost).toBe(true)
    expect(notified()).toBe(1)
    identity.current = true
    expect(opening.check()).toBe(false)
  })
})
