// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_LUCIDE_ICON_NAMES } from '../../../../shared/repo-lucide-icon-names'
import { getRepoLucideIconOptions, RepoIconGlyph } from './repo-icon'

afterEach(() => {
  cleanup()
})

const GHE_AVATAR = 'https://ghe.example.com/acme.png?size=64'

describe('getRepoLucideIconOptions', () => {
  it('lists every shared catalog icon in picker order', () => {
    expect(getRepoLucideIconOptions().map((option) => option.name)).toEqual([
      ...REPO_LUCIDE_ICON_NAMES
    ])
  })
})

describe('RepoIconGlyph', () => {
  it('falls back to a lucide icon when an image icon fails to load', () => {
    const { container } = render(
      <RepoIconGlyph repoIcon={{ type: 'image', src: GHE_AVATAR, source: 'github' }} />
    )

    const image = container.querySelector('img')
    expect(image).not.toBeNull()

    fireEvent.error(image as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('lucide-folder')
  })

  it('retries the image when the icon changes to a different src', () => {
    const { container, rerender } = render(
      <RepoIconGlyph repoIcon={{ type: 'image', src: GHE_AVATAR, source: 'github' }} />
    )
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(container.querySelector('img')).toBeNull()

    rerender(
      <RepoIconGlyph
        repoIcon={{ type: 'image', src: 'https://github.com/acme.png?size=64', source: 'github' }}
      />
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/acme.png?size=64'
    )
  })

  it('keeps rendering a loadable image icon', () => {
    const { container } = render(
      <RepoIconGlyph repoIcon={{ type: 'image', src: GHE_AVATAR, source: 'github' }} />
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(GHE_AVATAR)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders a newly cataloged lucide icon', () => {
    const { container } = render(<RepoIconGlyph repoIcon={{ type: 'lucide', name: 'Guitar' }} />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('lucide-guitar')
  })

  it('renders emoji and lucide icons unchanged', () => {
    const { container: emoji } = render(<RepoIconGlyph repoIcon={{ type: 'emoji', emoji: '🐙' }} />)
    expect(emoji.textContent).toBe('🐙')

    const { container: lucide } = render(
      <RepoIconGlyph repoIcon={{ type: 'lucide', name: 'Database' }} />
    )
    expect(lucide.querySelector('svg')?.getAttribute('class')).toContain('lucide-database')
  })

  it('falls back to Folder for an unknown lucide name', () => {
    const { container } = render(<RepoIconGlyph repoIcon={{ type: 'lucide', name: 'NotAnIcon' }} />)

    expect(container.querySelector('svg')?.getAttribute('class')).toContain('lucide-folder')
  })
})
