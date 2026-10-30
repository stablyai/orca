import { describe, expect, it } from 'vitest'
import {
  gitUrlPluginPublisher,
  localPluginPublisher,
  withPluginPublisher
} from './plugin-publisher-derivation'

describe('plugin publisher derivation', () => {
  it('names a Git URL after its owner, lowercased', () => {
    expect(gitUrlPluginPublisher('https://github.com/Acme/gleam.git')).toBe('acme')
    expect(gitUrlPluginPublisher('git@github.com:Acme/gleam.git')).toBe('acme')
    expect(gitUrlPluginPublisher('ssh://git@gitlab.com/acme/tools/gleam.git')).toBe('acme')
    expect(gitUrlPluginPublisher('https://gitlab.com/john.doe__x/gleam.git')).toBe('john-doe-x')
  })

  it('names nobody when the URL has no usable owner', () => {
    expect(gitUrlPluginPublisher('ssh://git@example.com/gleam.git')).toBeNull()
    expect(gitUrlPluginPublisher('https://github.com/constructor/gleam.git')).toBeNull()
    expect(gitUrlPluginPublisher('file:///tmp/acme/gleam')).toBeNull()
  })

  it('keeps a folder on its declared publisher while deprecated, else local', () => {
    expect(localPluginPublisher('acme')).toBe('acme')
    expect(localPluginPublisher(undefined)).toBe('local')
  })

  it('overrides whatever publisher the manifest declared', () => {
    expect(withPluginPublisher({ id: 'gleam', publisher: 'brand' }, 'acme')).toEqual({
      id: 'gleam',
      publisher: 'acme'
    })
  })
})
