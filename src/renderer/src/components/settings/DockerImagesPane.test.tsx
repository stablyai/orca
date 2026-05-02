import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DockerImagesPane, formatBytes } from './DockerImagesPane'

describe('DockerImagesPane', () => {
  it('formats image sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('renders cached image rows with prune buttons', () => {
    const markup = renderToStaticMarkup(
      <DockerImagesPane
        initialImages={[
          {
            id: 'sha256:abcdef1234567890',
            cacheKey: 'cache-key-1',
            dockerfilePath: '/repo/.devcontainer/Dockerfile',
            sizeBytes: 42 * 1024 * 1024,
            lastUsedAt: Date.UTC(2026, 4, 2, 12, 0)
          }
        ]}
      />
    )

    expect(markup).toContain('1 cached images')
    expect(markup).toContain('/repo/.devcontainer/Dockerfile')
    expect(markup).toContain('cache-key-1')
    expect(markup).toContain('Prune Docker image abcdef123456')
  })
})
