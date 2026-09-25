import { describe, expect, it } from 'vitest'
import {
  getCloneFolderNamePreview,
  getClonePathPreview
} from './repository-host-clone-path-preview'

describe('repository host clone path preview', () => {
  it('derives repository folders from HTTPS and SSH remotes', () => {
    expect(getCloneFolderNamePreview('https://github.com/stablyai/orca.git')).toBe('orca')
    expect(getCloneFolderNamePreview('git@github.com:stablyai/orca.git')).toBe('orca')
  })

  it('previews POSIX and Windows destinations', () => {
    expect(getClonePathPreview('/home/alice/projects/', 'orca')).toBe('/home/alice/projects/orca')
    expect(getClonePathPreview('C:\\Users\\alice\\projects\\', 'orca')).toBe(
      'C:\\Users\\alice\\projects\\orca'
    )
    expect(getClonePathPreview('/', 'orca')).toBe('/orca')
    expect(getClonePathPreview('\\', 'orca')).toBe('\\orca')
  })

  it('withholds incomplete previews', () => {
    expect(getCloneFolderNamePreview('')).toBeNull()
    expect(getCloneFolderNamePreview('file:///tmp/source/..')).toBeNull()
    expect(getCloneFolderNamePreview('git@example.com:acme\\orca.git')).toBeNull()
    expect(getClonePathPreview('', 'orca')).toBeNull()
    expect(getClonePathPreview('/projects', null)).toBeNull()
  })
})
