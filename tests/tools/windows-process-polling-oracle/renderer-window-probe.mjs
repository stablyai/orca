export async function collectRendererWindowMetrics({
  windowMs,
  ptyId,
  collectEventLoop = true,
  eventLoopIntervalMs = 50,
  foregroundPollMs = 2_000,
  probeSettleTimeoutMs = 10_000
}) {
  const delays = []
  const foregroundResults = []
  const pending = new Map()
  let requestSequence = 0
  let expected = performance.now() + eventLoopIntervalMs

  const poll = () => {
    const requestId = ++requestSequence
    const record = { requestId, startedAt: Date.now(), finishedAt: null }
    foregroundResults.push(record)
    pending.set(requestId, true)
    void (async () => {
      try {
        record.foreground = await window.api.pty.confirmForegroundProcess(ptyId)
      } catch (error) {
        record.error = String(error)
      } finally {
        record.finishedAt = Date.now()
        pending.delete(requestId)
      }
    })()
  }

  poll()
  const pollTimer = setInterval(poll, foregroundPollMs)
  const loopTimer = collectEventLoop
    ? setInterval(() => {
        const now = performance.now()
        delays.push(Math.max(0, now - expected))
        expected = now + eventLoopIntervalMs
      }, eventLoopIntervalMs)
    : null
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  clearInterval(pollTimer)
  if (loopTimer !== null) {
    clearInterval(loopTimer)
  }

  const settleDeadline = Date.now() + probeSettleTimeoutMs
  while (pending.size > 0 && Date.now() < settleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (pending.size > 0) {
    throw new Error(
      `foreground probes did not settle within ${probeSettleTimeoutMs}ms: ${[
        ...pending.keys()
      ].join(', ')}`
    )
  }

  delays.sort((left, right) => left - right)
  const percentile = (fraction) =>
    delays[Math.min(delays.length - 1, Math.floor(delays.length * fraction))]
  return {
    rendererEventLoop: collectEventLoop
      ? {
          samples: delays.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          maxMs: delays.at(-1)
        }
      : null,
    foregroundProbe: {
      ptyId,
      requestCount: foregroundResults.length,
      results: foregroundResults
    }
  }
}
