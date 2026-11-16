import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Page, Locator } from '@playwright/test'

export async function measureStickyPerformance(page: Page, composer: Locator, tracePath: string) {
  const instrumentation = await page.evaluate(() =>
    Object.fromEntries(
      ['chat', 'composer', 'strip'].map((name) => [
        name,
        performance.getEntriesByName(`sticky-workers:${name}:render`).length
      ])
    )
  )
  const stripPresent = (await page.locator('[data-native-chat-background-tasks]').count()) > 0
  if (
    Object.entries(instrumentation).some(
      ([name, count]) => count === 0 && (name !== 'strip' || stripPresent)
    )
  ) {
    throw new Error('This build lacks the required renderer measurement marks.')
  }
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
    await composer.evaluate((element) => {
      const samples: number[] = []
      element.setAttribute('data-sticky-key-latencies', '[]')
      let keys = 0
      const capture = (event: Event) => {
        const at = event.timeStamp
        requestAnimationFrame(() => {
          samples.push(performance.now() - at)
          element.setAttribute('data-sticky-key-latencies', JSON.stringify(samples))
        })
        if (++keys === 12) {
          element.removeEventListener('keydown', capture)
        }
      }
      element.addEventListener('keydown', capture)
    })
    await composer.pressSequentially(' typing12345')
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    )
    const keyToFrameMs: number[] = JSON.parse(
      (await composer.getAttribute('data-sticky-key-latencies')) ?? '[]'
    )
    const frames = await page.evaluate(async () => {
      const samples: number[] = []
      const strip = document.querySelector('[data-native-chat-background-tasks]')
      const region = strip?.querySelector('[role="region"]') ?? strip?.querySelector('[id]')
      const transcript = document.querySelector('[data-native-chat-scroll]')
      let last = performance.now()
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const now = performance.now()
        samples.push(now - last)
        last = now
        if (region) {
          region.scrollTop += frame % 2 ? 12 : -12
        }
        if (transcript) {
          transcript.scrollTop += frame % 2 ? 12 : -12
        }
      }
      return samples
    })
    if (repeat >= 5) {
      const previous = new Map(before.metrics.map((metric) => [metric.name, metric.value]))
      repeats.push({
        renderCounts: counts,
        residentRows: await page
          .locator('[data-worker-dock-row], [data-native-chat-background-tasks] li')
          .count(),
        keyToFrameMs,
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
    mkdirSync(dirname(tracePath), { recursive: true })
    writeFileSync(tracePath, chunks.join(''))
  }
  await client.detach()
  return {
    instrumentation,
    method:
      'Five warm edits/12-key inputs/90-frame scrolls, then five saved repeats; hidden Chromium keyboard-to-animation-frame latency, CDP renderer CPU metrics; identical temporary function-entry marks; browser trace retained',
    repeats
  }
}
