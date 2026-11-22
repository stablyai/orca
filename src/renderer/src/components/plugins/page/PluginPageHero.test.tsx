// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { pluginShaImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'
import { PluginScreenshots } from './PluginPageHero'

afterEach(cleanup)

const hash = 'a'.repeat(64)
const image = { kind: 'screenshot', width: 1600, height: 1000 } as const
const location = { sourceId: 'b'.repeat(32), commit: 'c'.repeat(40), path: 'screenshot.png' }

it('opens the selected screenshot when two captions share one image URL', () => {
  const url = pluginShaImageUrl(hash, image, { ...location, fetchedAt: 1 })
  render(
    <PluginScreenshots
      images={{
        screenshots: [
          { url, alt: 'First view', caption: 'First caption' },
          { url, alt: 'Second view', caption: 'Second caption' }
        ]
      }}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: /second view/i }))
  expect(screen.getByRole('dialog', { name: 'Second view' })).toBeTruthy()
  expect(screen.getByText('Second caption')).toBeTruthy()
})

it('retries a failed screenshot and requests it again after a new snapshot is published', () => {
  const screenshots = (fetchedAt: number) => [
    {
      url: pluginShaImageUrl(hash, image, { ...location, fetchedAt }),
      alt: 'Plugin view'
    }
  ]
  const { container, rerender } = render(
    <PluginScreenshots images={{ screenshots: screenshots(1) }} />
  )
  const renderedImage = () => container.querySelector('img')
  const first = renderedImage()!
  fireEvent.error(first)
  expect(new URL(first.src).searchParams.get('retry')).toBe('1')
  fireEvent.error(first)
  expect(renderedImage()).toBeNull()

  rerender(<PluginScreenshots images={{ screenshots: screenshots(2) }} />)
  expect(renderedImage()?.src).toBe(screenshots(2)[0]!.url)
})
