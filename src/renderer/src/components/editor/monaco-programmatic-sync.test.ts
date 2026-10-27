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
  it('ignores echoed shared-model changes in the sibling split pane', () => {
    const modelKey = '/repo/seed.spec.ts'

    beginProgrammaticContentSync(modelKey)
    try {
      expect(
        shouldIgnoreMonacoContentChange({
          modelKey,
          isApplyingProgrammaticContent: false
        })
      ).toBe(true)
    } finally {
      endProgrammaticContentSync(modelKey)
    }
  })

  it('ignores local programmatic sync even without a sibling pane', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        modelKey: '/repo/seed.spec.ts',
        isApplyingProgrammaticContent: true
      })
    ).toBe(true)
  })

  it('does not ignore a real user edit once programmatic sync is finished', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        modelKey: '/repo/seed.spec.ts',
        isApplyingProgrammaticContent: false
      })
    ).toBe(false)
  })

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
