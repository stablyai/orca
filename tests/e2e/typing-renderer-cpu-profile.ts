import type { Page } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function withTypingRendererCpuProfile<T>(
  page: Page,
  outputPath: string | undefined,
  measure: () => Promise<T>
): Promise<T> {
  if (!outputPath) {
    return measure()
  }
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 1000 })
    await session.send('Profiler.start')
    try {
      return await measure()
    } finally {
      const { profile } = await session.send('Profiler.stop')
      mkdirSync(path.dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, JSON.stringify(profile))
    }
  } finally {
    await session.detach()
  }
}
