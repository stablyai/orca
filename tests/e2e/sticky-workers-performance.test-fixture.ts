import { writeFileSync } from 'node:fs'
import type { Page, Locator } from '@playwright/test'

export async function measureStickyPerformance(page: Page, composer: Locator, tracePath: string) {
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  await client.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing',
    transferMode: 'ReturnAsStream'
  })
  const repeats: unknown[] = []
  const marks = ['chat', 'composer', 'strip']
  for (let repeat = 0; repeat < 10; repeat++) {
    await page.evaluate((marks) => {
      for (const mark of marks) {
        performance.clearMarks(`sticky-workers:${mark}:render`)
      }
    }, marks)
    const before = await client.send('Performance.getMetrics')
    await composer.fill(`Draft ${repeat}: review this work while the workers stay visible.`)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const after = await client.send('Performance.getMetrics')
    const counts = await page.evaluate(
      (marks) =>
        Object.fromEntries(
          marks.map((mark) => [
            mark,
            performance.getEntriesByName(`sticky-workers:${mark}:render`).length
          ])
        ),
      marks
    )
    const frames = await page.evaluate(async () => {
      const samples: number[] = []
      const region = document.querySelector('[data-native-chat-background-tasks] [role="region"]')
      let last = performance.now()
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const now = performance.now()
        samples.push(now - last)
        last = now
        if (region) {
          region.scrollTop += frame % 2 ? 12 : -12
        }
      }
      return samples
    })
    if (repeat >= 5) {
      const previous = new Map(before.metrics.map((metric) => [metric.name, metric.value]))
      repeats.push({
        renderCounts: counts,
        rendererMetricsDelta: Object.fromEntries(
          after.metrics
            .filter((metric) =>
              [
                'ScriptDuration',
                'TaskDuration',
                'LayoutDuration',
                'RecalcStyleDuration',
                'LayoutCount'
              ].includes(metric.name)
            )
            .map((metric) => [metric.name, metric.value - (previous.get(metric.name) ?? 0)])
        ),
        frames
      })
    }
  }
  const completed = new Promise<{ stream?: string }>((resolve) =>
    client.once('Tracing.tracingComplete', resolve)
  )
  await client.send('Tracing.end')
  const { stream } = await completed
  if (stream) {
    const chunks: string[] = []
    for (;;) {
      const chunk = await client.send('IO.read', { handle: stream })
      chunks.push(chunk.data)
      if (chunk.eof) {
        break
      }
    }
    await client.send('IO.close', { handle: stream })
    writeFileSync(tracePath, chunks.join(''))
  }
  await client.detach()
  return {
    method:
      'Five warm edits/90-frame scrolls, then five saved repeats; CDP renderer CPU metrics; temporary identical function-entry performance marks; browser trace retained',
    repeats
  }
}
