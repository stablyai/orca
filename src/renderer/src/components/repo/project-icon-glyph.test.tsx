// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { useAppStore } from '@/store'
import { ProjectIconGlyph } from './project-icon-glyph'

const githubAvatar: RepoIcon = {
  type: 'image',
  src: 'https://github.com/stablyai.png?size=64',
  source: 'github',
  label: 'stablyai/orca'
}

function setDefaultProjectIcon(defaults: Partial<GlobalSettings>): void {
  useAppStore.setState({ settings: defaults as GlobalSettings })
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ settings: null })
})

describe('ProjectIconGlyph', () => {
  it('draws the GitHub owner avatar while no default is set', () => {
    const { container } = render(<ProjectIconGlyph repoIcon={githubAvatar} color="#2563eb" />)

    expect(container.querySelector('img')?.getAttribute('src')).toBe(githubAvatar.src)
  })

  it('replaces the avatar with the default icon, tinted with the default color', () => {
    setDefaultProjectIcon({
      defaultProjectIcon: { type: 'lucide', name: 'Folder' },
      defaultProjectIconColor: '#e11d48'
    })

    const { container } = render(<ProjectIconGlyph repoIcon={githubAvatar} color="#2563eb" />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')?.getAttribute('style')).toContain('#e11d48')
  })

  it('fills in for a project that has no icon at all', () => {
    setDefaultProjectIcon({ defaultProjectIcon: { type: 'emoji', emoji: '🐳' } })

    const { container } = render(<ProjectIconGlyph repoIcon={null} color="#2563eb" />)

    expect(container.textContent).toContain('🐳')
  })

  it('leaves an icon the user chose for that project alone', () => {
    setDefaultProjectIcon({ defaultProjectIcon: { type: 'emoji', emoji: '🐳' } })

    const { container } = render(
      <ProjectIconGlyph
        repoIcon={{ type: 'image', src: 'https://www.google.com/s2/favicons', source: 'favicon' }}
        color="#2563eb"
      />
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://www.google.com/s2/favicons'
    )
  })
})
