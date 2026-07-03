import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_CONCURRENCY,
  MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT,
  extractMarkdownPreviewLocalImageCandidates,
  prewarmMarkdownPreviewLocalImages,
  type MarkdownPreviewLocalImageCandidate
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

  it('resolves Windows drive-letter and percent-escaped paths through image path helpers', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      ['![Drive](<C:\\repo\\assets\\diagram.png>)', '![Escaped](./space%20name.png)'].join('\n'),
      'C:\\repo\\docs\\readme.md'
    )

    expect(candidates.map((candidate) => candidate.absolutePath)).toEqual([
      'C:/repo/assets/diagram.png',
      'C:/repo/docs/space name.png'
    ])
  })

  it('resolves relative image paths from UNC markdown files through image path helpers', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      '![Unc](./unc.png)',
      '\\\\server\\share\\repo\\docs\\readme.md'
    )

    expect(candidates.map((candidate) => candidate.absolutePath)).toEqual([
      '//server/share/repo/docs/unc.png'
    ])
  })

  it('skips external, data, blob, raw HTML, and unsupported-scheme images', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      [
        '![Http](https://example.com/image.png)',
        '![Data](data:image/png;base64,abc)',
        '![Blob](blob:abc)',
        '![Mail](mailto:image@example.com)',
        '<img src="./raw-html.png" />',
        '![Local](./local.png)'
      ].join('\n'),
      '/repo/docs/readme.md'
    )

    expect(candidates.map((candidate) => candidate.absolutePath)).toEqual(['/repo/docs/local.png'])
  })

  it('dedupes by cache key after dropping query strings and fragments', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      ['![One](./logo.png?v=1#one)', '![Two](./logo.png?v=2#two)'].join('\n'),
      '/repo/docs/readme.md'
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.absolutePath).toBe('/repo/docs/logo.png')
  })

  it('caps candidates below the blob cache size', () => {
    const candidates = extractMarkdownPreviewLocalImageCandidates(
      markdownImages(MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT + 10),
      '/repo/docs/readme.md'
    )

    expect(candidates).toHaveLength(MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT)
    expect(candidates).toHaveLength(64)
  })

  it('uses runtime owner data when deduping cache keys', () => {
    const firstOwner = extractMarkdownPreviewLocalImageCandidates(
      '![Logo](./logo.png)',
      '/repo/docs/readme.md',
      {
        runtimeContext: {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        }
      }
    )
    const secondOwner = extractMarkdownPreviewLocalImageCandidates(
      '![Logo](./logo.png)',
      '/repo/docs/readme.md',
      {
        runtimeContext: {
          settings: { activeRuntimeEnvironmentId: 'env-2' },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        }
      }
    )

    expect(firstOwner[0]?.cacheKey).not.toBe(secondOwner[0]?.cacheKey)
  })
})

describe('prewarmMarkdownPreviewLocalImages', () => {
  it('prewarms capped, deduped candidates through the shared loader boundary', async () => {
    const loaded: MarkdownPreviewLocalImageCandidate[] = []
    const prewarm = prewarmMarkdownPreviewLocalImages(
      ['![One](./one.png)', '![Duplicate](./one.png?v=1)', '![Two](./two.png)'].join('\n'),
      '/repo/docs/readme.md',
      {
        loadImage: (candidate) => {
          loaded.push(candidate)
          return Promise.resolve(null)
        }
      }
    )

    await prewarm.done

    expect(loaded.map((candidate) => candidate.absolutePath)).toEqual([
      '/repo/docs/one.png',
      '/repo/docs/two.png'
    ])
  })

  it('does not enqueue more than the candidate cap', async () => {
    const loaded: MarkdownPreviewLocalImageCandidate[] = []
    const prewarm = prewarmMarkdownPreviewLocalImages(
      markdownImages(MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT + 5),
      '/repo/docs/readme.md',
      {
        concurrency: MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT,
        loadImage: (candidate) => {
          loaded.push(candidate)
          return Promise.resolve(null)
        }
      }
    )

    await prewarm.done

    expect(loaded).toHaveLength(MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_LIMIT)
  })

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

  it('uses the documented default concurrency', async () => {
    const pending: (() => void)[] = []
    const started: string[] = []

    const prewarm = prewarmMarkdownPreviewLocalImages(markdownImages(10), '/repo/docs/readme.md', {
      loadImage: (candidate) => {
        started.push(candidate.absolutePath)
        return new Promise((resolve) => {
          pending.push(() => resolve(null))
        })
      }
    })

    expect(started).toHaveLength(MARKDOWN_PREVIEW_LOCAL_IMAGE_PREWARM_CONCURRENCY)
    prewarm.cancel()
    for (const release of pending) {
      release()
    }
    await prewarm.done
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
