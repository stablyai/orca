import { describe, expect, it } from 'vitest'
import { resolveProjectIconDisplay, usesDefaultProjectIcon } from './default-project-icon'
import type { RepoIcon } from './repo-icon'

const githubAvatar: RepoIcon = {
  type: 'image',
  src: 'https://github.com/stablyai.png?size=64',
  source: 'github',
  label: 'stablyai/orca'
}
const folderDefault: RepoIcon = { type: 'lucide', name: 'Folder' }

describe('usesDefaultProjectIcon', () => {
  it('claims projects Orca picked a stand-in for', () => {
    expect(usesDefaultProjectIcon(null)).toBe(true)
    expect(usesDefaultProjectIcon(undefined)).toBe(true)
    expect(usesDefaultProjectIcon(githubAvatar)).toBe(true)
  })

  it('leaves every icon a user chose for that project', () => {
    expect(usesDefaultProjectIcon(folderDefault)).toBe(false)
    expect(usesDefaultProjectIcon({ type: 'emoji', emoji: '🐳' })).toBe(false)
    expect(
      usesDefaultProjectIcon({ type: 'image', src: 'data:image/png;base64,AA', source: 'upload' })
    ).toBe(false)
    expect(
      usesDefaultProjectIcon({
        type: 'image',
        src: 'https://www.google.com/s2/favicons?domain=orca.build&sz=64',
        source: 'favicon'
      })
    ).toBe(false)
  })
})

describe('resolveProjectIconDisplay', () => {
  it('keeps the avatar while no default is set', () => {
    expect(resolveProjectIconDisplay(githubAvatar, '#2563eb', {})).toEqual({
      repoIcon: githubAvatar,
      color: '#2563eb'
    })
    expect(resolveProjectIconDisplay(githubAvatar, '#2563eb', undefined)).toEqual({
      repoIcon: githubAvatar,
      color: '#2563eb'
    })
  })

  it('stands in for an avatar and for a project with no icon at all', () => {
    const preferences = { defaultProjectIcon: folderDefault }

    expect(resolveProjectIconDisplay(githubAvatar, '#2563eb', preferences).repoIcon).toBe(
      folderDefault
    )
    expect(resolveProjectIconDisplay(null, '#2563eb', preferences).repoIcon).toBe(folderDefault)
  })

  it('tints the default when a default color is set, and follows the project otherwise', () => {
    expect(
      resolveProjectIconDisplay(githubAvatar, '#2563eb', {
        defaultProjectIcon: folderDefault,
        defaultProjectIconColor: '#e11d48'
      }).color
    ).toBe('#e11d48')
    expect(
      resolveProjectIconDisplay(githubAvatar, '#2563eb', { defaultProjectIcon: folderDefault })
        .color
    ).toBe('#2563eb')
  })

  it('never overrides an icon the user chose for that project', () => {
    const emoji: RepoIcon = { type: 'emoji', emoji: '🐳' }

    expect(
      resolveProjectIconDisplay(emoji, '#2563eb', {
        defaultProjectIcon: folderDefault,
        defaultProjectIconColor: '#e11d48'
      })
    ).toEqual({ repoIcon: emoji, color: '#2563eb' })
  })
})
