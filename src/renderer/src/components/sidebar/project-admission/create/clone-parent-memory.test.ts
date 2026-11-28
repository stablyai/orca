import { describe, expect, it } from 'vitest'
import {
  cloneParentTargetKey,
  readCloneParentFolder,
  writeCloneParentFolder
} from './clone-parent-memory'

type TestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  values: Map<string, string>
}

function memoryStorage(): TestStorage {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  }
}

describe('clone parent memory', () => {
  it('reads back the folder written for the same target', () => {
    const storage = memoryStorage()
    writeCloneParentFolder('local', '/home/me/projects', storage)
    expect(readCloneParentFolder('local', storage)).toBe('/home/me/projects')
  })

  it('keeps local and runtime targets apart', () => {
    const storage = memoryStorage()
    writeCloneParentFolder('local', '/home/me/projects', storage)
    writeCloneParentFolder('runtime:abc', '/srv/repos', storage)
    expect(readCloneParentFolder('runtime:abc', storage)).toBe('/srv/repos')
    expect(readCloneParentFolder('runtime:other', storage)).toBe('')
    expect(readCloneParentFolder('local', storage)).toBe('/home/me/projects')
  })

  it('forgets a target when the folder is emptied', () => {
    const storage = memoryStorage()
    writeCloneParentFolder('local', '/home/me/projects', storage)
    writeCloneParentFolder('local', '   ', storage)
    expect(readCloneParentFolder('local', storage)).toBe('')
  })

  it('starts empty without storage or with damaged JSON', () => {
    const storage = memoryStorage()
    storage.values.set('orca.add-repo.clone-parent-folder', '{not json')
    expect(readCloneParentFolder('local', storage)).toBe('')
    expect(readCloneParentFolder('local', null)).toBe('')
  })

  it('keys a runtime clone by its environment and everything else as local', () => {
    expect(cloneParentTargetKey('  env-1 ')).toBe('runtime:env-1')
    expect(cloneParentTargetKey(undefined)).toBe('local')
    expect(cloneParentTargetKey('')).toBe('local')
  })
})
