import { describe, expect, it } from 'vitest'
import {
  extractMarkdownPreviewLocalImageCandidates,
  prewarmMarkdownPreviewLocalImages
} from './markdown-preview-local-images'

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function markdownImages(count: number): string {
  return Array.from({ length: count }, (_, index) => `![${index}](images/${index}.png)`).join('\n')
}

describe('extractMarkdownPreviewLocalImageCandidates', () => {
  it('extracts direct, reference-style, and GFM table images in document order', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      [
        '![Direct](./direct.png)',
        '![Reference][logo]',
        '',
        '| Asset |',
        '| --- |',
        '| ![Table](table.png) |',
        '',
        '[logo]: ../assets/logo.png'
      ].join('\n'),
      '/repo/docs/readme.md'
    )

    expect(candidates.map((candidate) => candidate.absolutePath)).toEqual([
      '/repo/docs/direct.png',
      '/repo/assets/logo.png',
      '/repo/docs/table.png'
    ])
  })
})

describe('prewarmMarkdownPreviewLocalImages', () => {
  it('never starts more reads than the concurrency limit at once', async () => {
    const releaseNext: (() => void)[] = []
    const started: string[] = []
    let active = 0
    let maxActive = 0

    const prewarm = prewarmMarkdownPreviewLocalImages(markdownImages(6), '/repo/docs/readme.md', {
      concurrency: 2,
      loadImage: (candidate) => {
        started.push(candidate.absolutePath)
        active += 1
        maxActive = Math.max(maxActive, active)
        return new Promise((resolve) => {
          releaseNext.push(() => {
            active -= 1
            resolve(null)
          })
        })
      }
    })

    expect(started).toHaveLength(2)
    releaseNext.shift()?.()
    await flushPromises()
    expect(started).toHaveLength(3)

    while (releaseNext.length > 0) {
      releaseNext.shift()?.()
      await flushPromises()
    }
    await prewarm.done

    expect(maxActive).toBe(2)
    expect(started).toHaveLength(6)
  })

  it('stops scheduling not-yet-started work after cancellation', async () => {
    const pending: (() => void)[] = []
    const started: string[] = []
    const prewarm = prewarmMarkdownPreviewLocalImages(markdownImages(5), '/repo/docs/readme.md', {
      concurrency: 2,
      loadImage: (candidate) => {
        started.push(candidate.absolutePath)
        return new Promise((resolve) => {
          pending.push(() => resolve(null))
        })
      }
    })

    expect(started).toHaveLength(2)
    prewarm.cancel()
    for (const release of pending) {
      release()
    }
    await prewarm.done

    expect(started).toHaveLength(2)
  })
})
