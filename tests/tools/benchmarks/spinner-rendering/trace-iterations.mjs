import { writeFileSync } from 'node:fs'

export async function traceIterations(cdp, outputPath, durationMs = 2200) {
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,toplevel,cc,viz,disabled-by-default-cc.debug.scheduler',
    transferMode: 'ReturnAsStream'
  })
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  const completion = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end')
  const { stream, dataLossOccurred } = await completion
  let json = ''
  try {
    while (true) {
      const part = await cdp.send('IO.read', { handle: stream })
      json += part.data
      if (part.eof) {
        break
      }
    }
  } finally {
    await cdp.send('IO.close', { handle: stream })
  }
  writeFileSync(outputPath, json)
  if (dataLossOccurred) {
    throw new Error(
      `Chromium dropped trace events; counts would be partial. Raw trace: ${outputPath}`
    )
  }
  const events = JSON.parse(json).traceEvents
  // The stop request can land late on a busy event loop; rate over what the trace actually covers.
  let first = Infinity
  let last = -Infinity
  for (const event of events) {
    if (event.ph !== 'M' && event.ts > 0) {
      first = Math.min(first, event.ts)
      last = Math.max(last, event.ts + (event.dur ?? 0))
    }
  }
  const measuredMs = (last - first) / 1000
  if (!(measuredMs > 0)) {
    throw new Error(
      `Trace has no timed events; rates would be meaningless. Raw trace: ${outputPath}`
    )
  }
  const compositorThreads = new Set(
    events
      .filter((event) => event.name === 'thread_name' && event.args?.name === 'Compositor')
      .map((event) => `${event.pid}:${event.tid}`)
  )
  const onCompositor = events.filter((event) => compositorThreads.has(`${event.pid}:${event.tid}`))
  const perSecond = (count) => Math.round((count * 1000) / measuredMs)
  // One per occurrence: slices and instants, not end markers or the flow events Chromium emits beside each frame.
  const OCCURRENCE_PHASES = new Set(['X', 'B', 'I', 'i'])
  const count = (list, name) =>
    list.filter((event) => event.name === name && OCCURRENCE_PHASES.has(event.ph)).length
  return {
    requestedMs: durationMs,
    measuredMs: Math.round(measuredMs),
    iterationEvents: events.filter(
      (event) => event.name === 'EventDispatch' && event.args?.data?.type === 'animationiteration'
    ).length,
    styleUpdates: count(events, 'UpdateLayoutTree'),
    // A spinner that wakes the compositor every refresh shows up as many no-damage frames.
    compositorFramesPerSecond: perSecond(count(onCompositor, 'Scheduler::BeginImplFrame')),
    noDamageFramesPerSecond: perSecond(count(onCompositor, 'EarlyOut_NoDamage')),
    // Main-thread frames: a compositor-only animation adds none.
    mainFramesPerSecond: perSecond(count(events, 'ProxyMain::BeginMainFrame')),
    // Each one redraws the whole window in the GPU process.
    windowRedrawsPerSecond: perSecond(count(events, 'Display::DrawAndSwap')),
    compositorThreadMsPerSecond:
      Math.round(
        (onCompositor
          .filter((event) => event.name === 'ThreadControllerImpl::RunTask')
          .reduce((total, event) => total + (event.tdur ?? event.dur ?? 0), 0) /
          measuredMs) *
          10
      ) / 10
  }
}
