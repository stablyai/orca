import { describe, expect, it } from 'vitest'
import { shouldBlockEditorTabLocalOpen } from './editor-tab-local-open-guard'

describe('shouldBlockEditorTabLocalOpen', () => {
  it('blocks remote-owned editor tabs even after the active runtime switches local', () => {
    expect(shouldBlockEditorTabLocalOpen({ activeRuntimeEnvironmentId: null }, 'env-1', null)).toBe(
      true
    )
  })

  it('blocks SSH editor tabs without a runtime owner', () => {
    expect(
      shouldBlockEditorTabLocalOpen({ activeRuntimeEnvironmentId: null }, undefined, 'ssh-1')
    ).toBe(true)
  })

  it('allows local editor tabs without runtime or SSH ownership', () => {
    expect(
      shouldBlockEditorTabLocalOpen({ activeRuntimeEnvironmentId: null }, undefined, null)
    ).toBe(false)
  })
})
