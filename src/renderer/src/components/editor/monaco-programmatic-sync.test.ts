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
    const filePath = '/repo/seed.spec.ts'

    beginProgrammaticContentSync(filePath)
    try {
      expect(
        shouldIgnoreMonacoContentChange({
          filePath,
          isApplyingProgrammaticContent: false
        })
      ).toBe(true)
    } finally {
      endProgrammaticContentSync(filePath)
    }
  })

  it('ignores local programmatic sync even without a sibling pane', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        filePath: '/repo/seed.spec.ts',
        isApplyingProgrammaticContent: true
      })
    ).toBe(true)
  })

  it('does not ignore a real user edit once programmatic sync is finished', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        filePath: '/repo/seed.spec.ts',
        isApplyingProgrammaticContent: false
      })
    ).toBe(false)
  })

  it('does not ignore a user edit that happens to match the saved prop content', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        filePath: '/repo/seed.spec.ts',
        isApplyingProgrammaticContent: false
      })
    ).toBe(false)
  })
})
