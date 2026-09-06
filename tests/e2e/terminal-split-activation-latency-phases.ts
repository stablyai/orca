export type RendererPhaseStamps = {
  marker: string
  sourcePaneId: number
  sourcePtyId: string
  newPaneId: number | null
  newPtyId: string | null
  rendererTimeOriginEpochMs: number
  keydownAtMs: number | null
  focusAtMs: number | null
  cwdRequestAtMs: number | null
  cwdSettledAtMs: number | null
  ptySpawnRequestAtMs: number | null
  ptySpawnResultAtMs: number | null
  ptyBoundAtMs: number | null
  fixtureUnlockRequestedAtMs: number | null
  fixtureUnlockIpcWriteAtMs: number | null
  fixtureUnlockIpcWriteChannel: 'pty:write' | 'pty:writeAccepted' | null
  fixtureReadyParsedAtMs: number | null
  inputAtMs: number | null
  firstEchoAtMs: number | null
}

export type SplitLatencyMainProbeEvent = {
  kind: 'cwd-request' | 'cwd-settled' | 'pty-spawn-request' | 'pty-spawn-result' | 'pty-write-cr'
  operationId: number | null
  atEpochMs: number
  ptyId: string | null
  writeChannel: 'pty:write' | 'pty:writeAccepted' | null
}

export type SplitLatencySample = RendererPhaseStamps & {
  phase: 'warmup' | 'measured'
  iteration: number
  completedWithinTimeout: boolean
  paneCountAfterProbe: number
  ptyExitObserved: boolean
  cleanupError: string | null
  shortcutToFocusMs: number | null
  shortcutToCwdRequestMs: number | null
  cwdLookupMs: number | null
  cwdSettleToPtySpawnRequestMs: number | null
  ptySpawnRequestToResultMs: number | null
  ptySpawnResultToBindMs: number | null
  shortcutToPtyBindMs: number | null
  ptyBindToFixtureUnlockRequestMs: number | null
  fixtureUnlockRequestToIpcWriteMs: number | null
  fixtureUnlockIpcWriteToReadyParseMs: number | null
  fixtureReadyParseToInputMs: number | null
  shortcutToFirstEchoMs: number | null
  ptyBindToFirstEchoMs: number | null
  inputToFirstEchoMs: number | null
  missing: string[]
  success: boolean
}

function elapsed(start: number | null, end: number | null): number | null {
  return start === null || end === null ? null : Math.max(0, end - start)
}

export function mergeSplitLatencyMainProbeEvents(
  stamps: RendererPhaseStamps,
  events: readonly SplitLatencyMainProbeEvent[]
): RendererPhaseStamps {
  const keydownEpochMs =
    stamps.keydownAtMs === null
      ? Number.NEGATIVE_INFINITY
      : stamps.rendererTimeOriginEpochMs + stamps.keydownAtMs
  const afterKeydown = events.filter((event) => event.atEpochMs >= keydownEpochMs - 2)
  const cwdRequest = afterKeydown.find(
    (event) => event.kind === 'cwd-request' && event.ptyId === stamps.sourcePtyId
  )
  const cwdSettled = cwdRequest
    ? afterKeydown.find(
        (event) => event.kind === 'cwd-settled' && event.operationId === cwdRequest.operationId
      )
    : undefined
  const spawnResult = afterKeydown.find(
    (event) => event.kind === 'pty-spawn-result' && event.ptyId === stamps.newPtyId
  )
  const spawnRequest = spawnResult
    ? afterKeydown.find(
        (event) =>
          event.kind === 'pty-spawn-request' && event.operationId === spawnResult.operationId
      )
    : undefined
  const unlockRequestEpochMs =
    stamps.fixtureUnlockRequestedAtMs === null
      ? Number.NEGATIVE_INFINITY
      : stamps.rendererTimeOriginEpochMs + stamps.fixtureUnlockRequestedAtMs
  const fixtureUnlockWrite = afterKeydown.find(
    (event) =>
      event.kind === 'pty-write-cr' &&
      event.ptyId === stamps.newPtyId &&
      event.atEpochMs >= unlockRequestEpochMs - 2
  )
  const toRendererTime = (event: SplitLatencyMainProbeEvent | undefined): number | null =>
    event ? event.atEpochMs - stamps.rendererTimeOriginEpochMs : null

  return {
    ...stamps,
    cwdRequestAtMs: toRendererTime(cwdRequest),
    cwdSettledAtMs: toRendererTime(cwdSettled),
    ptySpawnRequestAtMs: toRendererTime(spawnRequest),
    ptySpawnResultAtMs: toRendererTime(spawnResult),
    fixtureUnlockIpcWriteAtMs: toRendererTime(fixtureUnlockWrite),
    fixtureUnlockIpcWriteChannel: fixtureUnlockWrite?.writeChannel ?? null
  }
}

export function createSplitLatencySample(args: {
  phase: SplitLatencySample['phase']
  iteration: number
  stamps: RendererPhaseStamps
  completedWithinTimeout: boolean
  paneCountAfterProbe: number
  ptyExitObserved: boolean
  cleanupError: string | null
}): SplitLatencySample {
  const { stamps } = args
  const missing = [
    ...(stamps.keydownAtMs === null ? ['keydown'] : []),
    ...(stamps.focusAtMs === null ? ['focus'] : []),
    ...(stamps.cwdRequestAtMs === null ? ['cwd-request'] : []),
    ...(stamps.cwdSettledAtMs === null ? ['cwd-settled'] : []),
    ...(stamps.ptySpawnRequestAtMs === null ? ['pty-spawn-request'] : []),
    ...(stamps.ptySpawnResultAtMs === null ? ['pty-spawn-result'] : []),
    ...(stamps.ptyBoundAtMs === null ? ['pty-bind'] : []),
    ...(stamps.fixtureUnlockRequestedAtMs === null ? ['fixture-unlock-request'] : []),
    ...(stamps.fixtureUnlockIpcWriteAtMs === null ? ['fixture-unlock-ipc-write'] : []),
    ...(stamps.fixtureReadyParsedAtMs === null ? ['fixture-ready-parse'] : []),
    ...(stamps.inputAtMs === null ? ['input'] : []),
    ...(stamps.firstEchoAtMs === null ? ['first-echo'] : []),
    ...(stamps.newPtyId === stamps.sourcePtyId ? ['pty-identity'] : []),
    ...(args.paneCountAfterProbe !== 2 ? [`pane-count:${args.paneCountAfterProbe}`] : []),
    ...(!args.ptyExitObserved ? ['pty-exit'] : []),
    ...(args.cleanupError ? ['cleanup'] : [])
  ]
  return {
    ...stamps,
    phase: args.phase,
    iteration: args.iteration,
    completedWithinTimeout: args.completedWithinTimeout,
    paneCountAfterProbe: args.paneCountAfterProbe,
    ptyExitObserved: args.ptyExitObserved,
    cleanupError: args.cleanupError,
    shortcutToFocusMs: elapsed(stamps.keydownAtMs, stamps.focusAtMs),
    shortcutToCwdRequestMs: elapsed(stamps.keydownAtMs, stamps.cwdRequestAtMs),
    cwdLookupMs: elapsed(stamps.cwdRequestAtMs, stamps.cwdSettledAtMs),
    cwdSettleToPtySpawnRequestMs: elapsed(stamps.cwdSettledAtMs, stamps.ptySpawnRequestAtMs),
    ptySpawnRequestToResultMs: elapsed(stamps.ptySpawnRequestAtMs, stamps.ptySpawnResultAtMs),
    ptySpawnResultToBindMs: elapsed(stamps.ptySpawnResultAtMs, stamps.ptyBoundAtMs),
    shortcutToPtyBindMs: elapsed(stamps.keydownAtMs, stamps.ptyBoundAtMs),
    ptyBindToFixtureUnlockRequestMs: elapsed(
      stamps.ptyBoundAtMs,
      stamps.fixtureUnlockRequestedAtMs
    ),
    fixtureUnlockRequestToIpcWriteMs: elapsed(
      stamps.fixtureUnlockRequestedAtMs,
      stamps.fixtureUnlockIpcWriteAtMs
    ),
    fixtureUnlockIpcWriteToReadyParseMs: elapsed(
      stamps.fixtureUnlockIpcWriteAtMs,
      stamps.fixtureReadyParsedAtMs
    ),
    fixtureReadyParseToInputMs: elapsed(stamps.fixtureReadyParsedAtMs, stamps.inputAtMs),
    shortcutToFirstEchoMs: elapsed(stamps.keydownAtMs, stamps.firstEchoAtMs),
    ptyBindToFirstEchoMs: elapsed(stamps.ptyBoundAtMs, stamps.firstEchoAtMs),
    inputToFirstEchoMs: elapsed(stamps.inputAtMs, stamps.firstEchoAtMs),
    missing,
    success: args.completedWithinTimeout && missing.length === 0
  }
}
