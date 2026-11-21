import { writeFileSync } from 'node:fs'

export async function traceIterations(cdp, outputPath, durationMs = 2200) {
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,toplevel,cc,disabled-by-default-cc.debug.scheduler',
    transferMode: 'ReturnAsStream'
  })
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  const completion = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end')
  const { stream } = await completion
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
  const events = JSON.parse(json).traceEvents
  const compositorThreads = new Set(
    events
      .filter((event) => event.name === 'thread_name' && event.args?.name === 'Compositor')
      .map((event) => `${event.pid}:${event.tid}`)
  )
  const onCompositor = events.filter((event) => compositorThreads.has(`${event.pid}:${event.tid}`))
  const perSecond = (count) => Math.round((count * 1000) / durationMs)
  return {
    durationMs,
    iterationEvents: events.filter(
      (event) => event.name === 'EventDispatch' && event.args?.data?.type === 'animationiteration'
    ).length,
    styleUpdates: events.filter((event) => event.name === 'UpdateLayoutTree').length,
    // A spinner that wakes the compositor every refresh shows up as many no-damage frames.
    compositorFramesPerSecond: perSecond(
      onCompositor.filter((event) => event.name === 'Scheduler::BeginImplFrame').length
    ),
    noDamageFramesPerSecond: perSecond(
      onCompositor.filter((event) => event.name === 'EarlyOut_NoDamage').length
    ),
    compositorThreadMsPerSecond:
      Math.round(
        (onCompositor
          .filter((event) => event.name === 'ThreadControllerImpl::RunTask')
          .reduce((total, event) => total + (event.tdur ?? event.dur ?? 0), 0) /
          durationMs) *
          10
      ) / 10
  }
}
