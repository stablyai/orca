// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getOpenInAppPresets, OpenInApplicationIcon } from './open-in-app-catalog'

afterEach(() => {
  cleanup()
})

describe('OpenInApplicationIcon', () => {
  it('renders every built-in preset icon from a bundled asset, never a network URL (#49526)', () => {
    for (const preset of getOpenInAppPresets()) {
      const { container, unmount } = render(<OpenInApplicationIcon application={preset} />)
      const src = container.querySelector('img')?.getAttribute('src')
      expect(src, preset.id).toBeTruthy()
      expect(src, preset.id).not.toMatch(/^(https?:)?\/\//i)
      unmount()
    }
  })
})
