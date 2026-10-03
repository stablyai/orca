import { describe, expect, it } from 'vitest'
import {
  FOLDER_COLOR_PALETTE,
  folderColorOverrideKey,
  isFolderColorHex,
  resolveFolderColorOverride,
  setFolderColorOverride
} from './folder-color-palette'

describe('folder color palette', () => {
  it('exposes the requested colors and Orca blue exactly', () => {
    expect(FOLDER_COLOR_PALETTE.map(({ hex }) => hex)).toEqual([
      '#C90161',
      '#740363',
      '#810742',
      '#DD740D',
      '#CE331A',
      '#F6CA0F',
      '#309027',
      '#B9C303',
      '#E6972A',
      '#2F8DC9',
      '#17867C',
      '#1E1C64',
      '#3B82F6'
    ])
  })

  it('resolves colors by exact folder path and normalizes persisted casing', () => {
    const overrides = {
      '/repo/src': '#c90161',
      '/repo/docs': '#NOT-A-COLOR'
    }

    expect(resolveFolderColorOverride(overrides, '/repo/src')).toBe('#C90161')
    expect(resolveFolderColorOverride(overrides, '/other/src')).toBeNull()
    expect(resolveFolderColorOverride(overrides, '/repo/docs')).toBeNull()
    expect(isFolderColorHex('#3b82f6')).toBe(true)
  })

  it('sets and clears one path without changing another folder', () => {
    const first = setFolderColorOverride({}, '/repo/src', '#309027')
    const second = setFolderColorOverride(first, '/repo/docs', '#740363')
    const cleared = setFolderColorOverride(second, '/repo/src', null)

    expect(cleared).toEqual({ '/repo/docs': '#740363' })
  })

  it('isolates identical remote paths by execution scope', () => {
    expect(folderColorOverrideKey('/repo/src', 'ssh:server-a')).not.toBe(
      folderColorOverrideKey('/repo/src', 'ssh:server-b')
    )
    expect(folderColorOverrideKey('/repo/src')).toBe('/repo/src')
  })
})
