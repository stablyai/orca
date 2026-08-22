import { describe, it, expect } from 'vitest'
import {
  buildFleetEcho,
  FLEET_ECHO_MAX_LANES,
  FLEET_ECHO_SCAN_LIMIT,
  type FleetEchoDispatch,
  type FleetEchoSources
} from './orchestration-fleet-echo'

const NOW = 1_000_000

function makeSources(overrides: Partial<FleetEchoSources> = {}): FleetEchoSources {
  return {
    listActiveDispatches: () => [],
    getWorkerStage: () => null,
    getTerminalSignal: () => null,
    now: () => NOW,
    ...overrides
  }
}

function dispatch(overrides: Partial<FleetEchoDispatch> = {}): FleetEchoDispatch {
  return {
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    assigneeHandle: 'term_a',
    status: 'dispatched',
    dispatchedAt: NOW - 60_000,
    lastHeartbeatAt: null,
    ...overrides
  }
}

describe('buildFleetEcho', () => {
  it('ranks the lanes that need attention above the healthy ones before capping', () => {
    // Why: the cap only costs anything when it hides the broken lane, so a lane created last must
    // still be reported ahead of a dozen healthy ones created before it.
    const healthy = Array.from({ length: FLEET_ECHO_MAX_LANES }, (_unused, index) =>
      dispatch({ dispatchId: `ctx_ok_${index}`, assigneeHandle: `term_ok_${index}` })
    )
    const broken = dispatch({ dispatchId: 'ctx_broken', assigneeHandle: 'term_broken' })
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [...healthy, broken],
        getWorkerStage: (dispatchId) => (dispatchId === 'ctx_broken' ? 'starting' : 'input_accepted'),
        getTerminalSignal: () => ({ lastOutputAt: NOW - 1_000, processState: 'unknown' })
      })
    )

    expect(echo.lanes[0].dispatchId).toBe('ctx_broken')
    expect(echo.lanes).toHaveLength(FLEET_ECHO_MAX_LANES)
    expect(echo.truncated).toBe(true)
  })

  it('ranks a read verdict above an inferred one, and a dead process above a quiet lane', () => {
    const inferred = dispatch({ dispatchId: 'ctx_inferred', assigneeHandle: 'term_inferred' })
    const read = dispatch({ dispatchId: 'ctx_read', assigneeHandle: 'term_read' })
    const dead = dispatch({ dispatchId: 'ctx_dead', assigneeHandle: 'term_dead' })
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [inferred, dead, read],
        getWorkerStage: (dispatchId) => (dispatchId === 'ctx_read' ? 'starting' : null),
        getTerminalSignal: (handle) =>
          handle === 'term_dead'
            ? { lastOutputAt: NOW - 1_000, processState: 'dead' }
            : { lastOutputAt: NOW - 120_000, processState: 'unknown' }
      })
    )

    expect(echo.lanes.map((lane) => lane.dispatchId)).toEqual([
      'ctx_read',
      'ctx_inferred',
      'ctx_dead'
    ])
  })

  it('keeps the query order among lanes of equal severity', () => {
    const first = dispatch({ dispatchId: 'ctx_1', assigneeHandle: 'term_1' })
    const second = dispatch({ dispatchId: 'ctx_2', assigneeHandle: 'term_2' })
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [first, second],
        getWorkerStage: () => 'input_accepted',
        getTerminalSignal: () => ({ lastOutputAt: NOW - 5_000, processState: 'unknown' })
      })
    )

    expect(echo.lanes.map((lane) => lane.dispatchId)).toEqual(['ctx_1', 'ctx_2'])
  })

  it('scans wider than it reports, so ranking sees lanes the cap would have dropped', () => {
    expect(FLEET_ECHO_SCAN_LIMIT).toBeGreaterThan(FLEET_ECHO_MAX_LANES)
  })

  it('names the worker row as the basis when a stage was read', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getWorkerStage: () => 'input_accepted'
      })
    )

    expect(echo.lanes[0]).toMatchObject({
      delivery: 'accepted',
      deliveryEvidence: 'worker_stage'
    })
  })

  it('names the terminal as the basis when no worker row exists', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getWorkerStage: () => null,
        getTerminalSignal: () => ({ lastOutputAt: NOW - 120_000, processState: 'unknown' })
      })
    )

    // Why: the lane is an unsupervised `dispatch --inject`, so this verdict is inferred, not read.
    expect(echo.lanes[0]).toMatchObject({
      delivery: 'not_accepted',
      deliveryEvidence: 'terminal_output'
    })
  })

  it('names no basis when nothing was available to read', () => {
    const pendingEcho = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch({ status: 'pending' })] })
    )
    const noSignalEcho = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getWorkerStage: () => null,
        getTerminalSignal: () => null
      })
    )

    expect(pendingEcho.lanes[0]).toMatchObject({ delivery: 'unknown', deliveryEvidence: null })
    expect(noSignalEcho.lanes[0]).toMatchObject({ delivery: 'unknown', deliveryEvidence: null })
  })

  it('reports heartbeat age from the last accepted heartbeat', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ lastHeartbeatAt: NOW - 240_000 })]
      })
    )

    expect(echo.lanes[0].heartbeatAgeMs).toBe(240_000)
  })

  it('reports a null heartbeat age for a lane that has never heartbeated', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch({ lastHeartbeatAt: null })] })
    )

    expect(echo.lanes[0].heartbeatAgeMs).toBeNull()
  })

  it('keeps an epoch-zero heartbeat as a real age rather than reading it as absent', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch({ lastHeartbeatAt: 0 })] })
    )

    expect(echo.lanes[0].heartbeatAgeMs).toBe(NOW)
  })

  it('clamps a heartbeat stamped in the future to zero rather than a negative age', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch({ lastHeartbeatAt: NOW + 30_000 })] })
    )

    expect(echo.lanes[0].heartbeatAgeMs).toBe(0)
  })

  it('derives quiet time from the terminal last-output timestamp', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getTerminalSignal: () => ({ lastOutputAt: NOW - 5_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].quietMs).toBe(5_000)
    expect(echo.lanes[0].processState).toBe('live')
  })

  it('reports not_accepted when the worker never reached input_accepted', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getWorkerStage: () => 'starting'
      })
    )

    expect(echo.lanes[0].delivery).toBe('not_accepted')
  })

  it('reports accepted once the worker stage records input_accepted', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getWorkerStage: () => 'input_accepted'
      })
    )

    expect(echo.lanes[0].delivery).toBe('accepted')
  })

  it('falls back to output-since-dispatch when there is no worker dispatch row', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ dispatchedAt: NOW - 60_000 })],
        // Why: the terminal spoke after the prompt landed, so a turn started.
        getTerminalSignal: () => ({ lastOutputAt: NOW - 30_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].delivery).toBe('accepted')
  })

  it('reports not_accepted when nothing was emitted after the dispatch landed', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ dispatchedAt: NOW - 60_000 })],
        getTerminalSignal: () => ({ lastOutputAt: NOW - 90_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].delivery).toBe('not_accepted')
  })

  it('reports unknown for a pending lane even when it looks not_accepted, without any time threshold', () => {
    // Why: 'pending' only means worker-start is in flight (setup -> worktree -> terminal ->
    // agent readiness -> authority attach); reporting anything but unknown here would tell the
    // coordinator to re-dispatch a lane that just hasn't finished starting yet.
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [
          dispatch({ status: 'pending', dispatchedAt: NOW - 10 * 60_000 })
        ],
        getWorkerStage: () => 'started',
        getTerminalSignal: () => ({ lastOutputAt: NOW - 9 * 60_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].delivery).toBe('unknown')
  })

  it('reports unknown when neither a worker stage nor a dispatch time is known', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch({ dispatchedAt: null })] })
    )

    expect(echo.lanes[0].delivery).toBe('unknown')
  })

  it('prefers the worker stage over the output heuristic', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ dispatchedAt: NOW - 60_000 })],
        getWorkerStage: () => 'input_accepted',
        getTerminalSignal: () => ({ lastOutputAt: NOW - 90_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].delivery).toBe('accepted')
  })

  it('reports unknown signals for a lane with no resolvable terminal', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ assigneeHandle: null })]
      })
    )

    expect(echo.lanes[0].quietMs).toBeNull()
    expect(echo.lanes[0].processState).toBe('unknown')
  })

  it('never reports negative quiet time when a clock skews backwards', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch()],
        getTerminalSignal: () => ({ lastOutputAt: NOW + 5_000, processState: 'live' })
      })
    )

    expect(echo.lanes[0].quietMs).toBe(0)
  })

  it('clamps a caller-supplied limit to the hard cap', () => {
    const many = Array.from({ length: FLEET_ECHO_MAX_LANES + 5 }, (_unused, index) =>
      dispatch({ dispatchId: `ctx_${index}`, taskId: `task_${index}` })
    )
    const echo = buildFleetEcho('run_1', makeSources({ listActiveDispatches: () => many }), 500)

    expect(echo.lanes).toHaveLength(FLEET_ECHO_MAX_LANES)
    expect(echo.truncated).toBe(true)
  })

  it('treats an epoch-zero output timestamp as a real time, not as absent', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({
        listActiveDispatches: () => [dispatch({ dispatchedAt: NOW - 60_000 })],
        getTerminalSignal: () => ({ lastOutputAt: 0, processState: 'live' })
      })
    )

    expect(echo.lanes[0].quietMs).toBe(NOW)
    // Why: 0 predates the dispatch, so delivery must read it as "nothing since", not as "unknown".
    expect(echo.lanes[0].delivery).toBe('not_accepted')
  })

  it('caps lanes at the limit and flags truncation', () => {
    const many = Array.from({ length: FLEET_ECHO_MAX_LANES + 3 }, (_unused, index) =>
      dispatch({ dispatchId: `ctx_${index}`, taskId: `task_${index}` })
    )
    const echo = buildFleetEcho('run_1', makeSources({ listActiveDispatches: () => many }))

    expect(echo.lanes).toHaveLength(FLEET_ECHO_MAX_LANES)
    expect(echo.truncated).toBe(true)
  })

  it('does not flag truncation when every lane fits', () => {
    const echo = buildFleetEcho(
      'run_1',
      makeSources({ listActiveDispatches: () => [dispatch()] })
    )

    expect(echo.truncated).toBe(false)
  })
})
