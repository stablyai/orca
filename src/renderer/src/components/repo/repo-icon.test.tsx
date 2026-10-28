// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_LUCIDE_ICON_NAMES } from '../../../../shared/repo-lucide-icon-names'
import { i18n } from '@/i18n/i18n'
import { getRepoLucideIconOptions, RepoIconGlyph } from './repo-icon'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const GHE_AVATAR = 'https://ghe.example.com/acme.png?size=64'

describe('getRepoLucideIconOptions', () => {
  it('lists every shared catalog icon in picker order', () => {
    expect(getRepoLucideIconOptions().map((option) => option.name)).toEqual([
      ...REPO_LUCIDE_ICON_NAMES
    ])
  })

  it('rebuilds translated labels after switching languages', async () => {
    const folder = getRepoLucideIconOptions().find((option) => option.name === 'Folder')
    expect(folder?.label).toBe('Folder')

    await i18n.changeLanguage('es')
    const folderSpanish = getRepoLucideIconOptions().find((option) => option.name === 'Folder')
    expect(folderSpanish?.label).toBe('Carpeta')
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

  it('renders a newly cataloged lucide icon', () => {
    const { container } = render(<RepoIconGlyph repoIcon={{ type: 'lucide', name: 'Guitar' }} />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('lucide-guitar')
  })
})
