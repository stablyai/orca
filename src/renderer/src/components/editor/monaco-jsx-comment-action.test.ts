import { describe, expect, it } from 'vitest'
import {
  areSelectionsEqual,
  createSerialCommentAction,
  getJsxCommentActionMode
} from './monaco-jsx-comment-action'

describe('Monaco JSX comment action', () => {
  it('classifies mixed and unknown selections for the safe no-op policy', () => {
    expect(getJsxCommentActionMode(['script'])).toBe('script')
    expect(getJsxCommentActionMode(['jsx', 'jsx'])).toBe('jsx')
    expect(getJsxCommentActionMode(['jsx', 'script'])).toBe('mixed')
    expect(getJsxCommentActionMode(['jsx', 'unknown'])).toBe('unknown')
  })

  it('detects selection changes that occur during asynchronous classification', () => {
    const captured = [
      {
        selectionStartLineNumber: 2,
        selectionStartColumn: 3,
        positionLineNumber: 2,
        positionColumn: 3
      }
    ]

    expect(areSelectionsEqual(captured, captured)).toBe(true)
    expect(
      areSelectionsEqual(captured, [
        {
          selectionStartLineNumber: 3,
          selectionStartColumn: 3,
          positionLineNumber: 3,
          positionColumn: 3
        }
      ])
    ).toBe(false)
    expect(areSelectionsEqual(captured, null)).toBe(false)
  })

  it('queues repeated shortcut actions instead of dropping them', async () => {
    const events: string[] = []
    let releaseFirstAction: (() => void) | undefined
    const firstActionBarrier = new Promise<void>((resolve) => {
      releaseFirstAction = resolve
    })
    let actionNumber = 0
    const run = createSerialCommentAction(async () => {
      actionNumber += 1
      const currentAction = actionNumber
      events.push(`start:${currentAction}`)
      if (currentAction === 1) {
        await firstActionBarrier
      }
      events.push(`end:${currentAction}`)
    })

    const first = run()
    const second = run()
    await Promise.resolve()
    expect(events).toEqual(['start:1'])

    releaseFirstAction?.()
    await Promise.all([first, second])
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  })
})
