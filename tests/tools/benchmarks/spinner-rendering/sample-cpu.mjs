export async function sampleCpu(app, cdp, sampleMs) {
  const rendererMetrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value])
    )
  const processMetrics = () =>
    app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map(({ pid, type, cpu }) => ({ pid, type, seconds: cpu.cumulativeCPUUsage }))
    )
  const beforeRenderer = await rendererMetrics()
  const before = await processMetrics()
  const started = performance.now()
  await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const after = await processMetrics()
  const elapsedMs = performance.now() - started
  const afterRenderer = await rendererMetrics()
  return {
    elapsedMs,
    cpuMsPerSecond: after.map((process) => {
      const previous = before.find((row) => row.pid === process.pid)?.seconds
      return {
        pid: process.pid,
        type: process.type,
        value:
          typeof previous === 'number' && typeof process.seconds === 'number'
            ? ((process.seconds - previous) * 1e6) / elapsedMs
            : null
      }
    }),
    rendererMsPerSecond: Object.fromEntries(
      ['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration'].map((name) => [
        name,
        ((afterRenderer[name] - beforeRenderer[name]) * 1e6) / elapsedMs
      ])
    ),
    rendererCountsPerSecond: Object.fromEntries(
      ['RecalcStyleCount', 'LayoutCount'].map((name) => [
        name,
        ((afterRenderer[name] - beforeRenderer[name]) * 1000) / elapsedMs
      ])
    )
  }
}
