import { afterEach, describe, expect, it } from 'vitest'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  resetProgrammaticContentSyncForTests,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'

afterEach(() => {
  resetProgrammaticContentSyncForTests()
})

describe('shouldIgnoreMonacoContentChange', () => {
  it('keeps nested sync suppression scoped to one model owner', () => {
    const local = 'file:///repo/file.ts'
    const remote = `${local}#remote-owner`
    beginProgrammaticContentSync(local)
    beginProgrammaticContentSync(local)
    endProgrammaticContentSync(local)
    expect(
      shouldIgnoreMonacoContentChange({ modelKey: local, isApplyingProgrammaticContent: false })
    ).toBe(true)
    expect(
      shouldIgnoreMonacoContentChange({ modelKey: remote, isApplyingProgrammaticContent: false })
    ).toBe(false)
    endProgrammaticContentSync(local)
    expect(
      shouldIgnoreMonacoContentChange({ modelKey: local, isApplyingProgrammaticContent: false })
    ).toBe(false)
  })
})
