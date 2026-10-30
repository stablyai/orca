import { writeFileSync } from 'node:fs'

export async function traceIterations(cdp, outputPath, durationMs = 2200) {
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline',
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
  return {
    durationMs,
    iterationEvents: events.filter(
      (event) => event.name === 'EventDispatch' && event.args?.data?.type === 'animationiteration'
    ).length,
    styleUpdates: events.filter((event) => event.name === 'UpdateLayoutTree').length
  }
}
