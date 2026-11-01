import { describe, expect, it } from 'vitest'
import {
  defaultCreationHost,
  defaultScopeHost,
  defaultScopeSource,
  rowLessSourceTarget
} from './default-creation-host'

describe('defaultCreationHost', () => {
  it('is this computer unless a server is chosen', () => {
    expect(defaultCreationHost(null)).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: null })).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: ' env-a ' })).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })
})

describe('row-less sources', () => {
  it('starts on the default host until a source or host is named', () => {
    const settings = { activeRuntimeEnvironmentId: 'env-a' }
    expect(defaultScopeHost(settings)).toEqual({ kind: 'environment', environmentId: 'env-a' })
    expect(rowLessSourceTarget(defaultScopeSource(settings))).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
    expect(rowLessSourceTarget({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(
      rowLessSourceTarget({
        kind: 'task-source',
        provider: 'linear',
        projectId: 'p',
        hostId: 'runtime:env-b'
      })
    ).toEqual({ kind: 'environment', environmentId: 'env-b' })
  })
})
