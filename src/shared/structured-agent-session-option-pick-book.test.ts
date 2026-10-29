import { describe, expect, it } from 'vitest'
import {
  beginStructuredOptionPick,
  createStructuredOptionPickBook,
  observeStructuredPermissionReport,
  resetStructuredOptionPickBook,
  settleStructuredOptionPick,
  structuredOptionPickCommit,
  structuredPermissionPickStands
} from './structured-agent-session-option-pick-book'

describe('structured option pick commits', () => {
  it('commits only its own option when another option was picked since', () => {
    const book = createStructuredOptionPickBook()
    const model = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'effort', 'low', false)
    expect(structuredOptionPickCommit(book, model, { model: 'opus', effort: 'high' })).toEqual({
      model: 'opus'
    })
  })

  it('commits nothing once the same option was picked again', () => {
    const book = createStructuredOptionPickBook()
    const first = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'model', 'sonnet', false)
    expect(structuredOptionPickCommit(book, first, undefined)).toBeNull()
    settleStructuredOptionPick(book, first)
    expect(book.pending).toEqual({ model: 'sonnet' })
  })
})

describe('a permission pick over the agent report', () => {
  const reporting = (mode: string | null) => ({ runtimePermission: { fence: 1, mode } })
  const gone = { runtimePermission: null }
  const pickMode = (book: ReturnType<typeof createStructuredOptionPickBook>, mode: string) =>
    beginStructuredOptionPick(book, 'permissionMode', mode, true)
  const observe = (book: ReturnType<typeof createStructuredOptionPickBook>, summary: unknown) => {
    const stands = structuredPermissionPickStands(book, summary, 1)
    observeStructuredPermissionReport(book, summary, 1)
    // A render before the observation must agree with one after it.
    expect(structuredPermissionPickStands(book, summary, 1)).toBe(stands)
    return stands
  }

  it('stands over the report it was made over until a different report arrives', () => {
    const book = createStructuredOptionPickBook()
    observe(book, reporting('ask'))
    beginStructuredOptionPick(book, 'model', 'opus', false)
    expect(structuredPermissionPickStands(book, reporting('ask'), 1)).toBe(false)
    pickMode(book, 'full-access')
    expect(observe(book, reporting('ask'))).toBe(true)
    expect(observe(book, gone)).toBe(false)
    expect(observe(book, reporting('ask'))).toBe(false)
  })

  it('a report that disagrees with the pick wins', () => {
    const book = createStructuredOptionPickBook()
    observe(book, reporting('ask'))
    pickMode(book, 'full-access')
    expect(observe(book, reporting('accept-edits'))).toBe(false)
  })

  it('keeps the latest of two quick picks standing while the agent takes the first', () => {
    const book = createStructuredOptionPickBook()
    observe(book, reporting('ask'))
    pickMode(book, 'accept-edits')
    pickMode(book, 'auto')
    expect(observe(book, reporting('accept-edits'))).toBe(true)
    expect(observe(book, reporting('accept-edits'))).toBe(true)
    expect(observe(book, reporting('auto'))).toBe(false)
  })

  it('drops a refused pick, but not one a newer pick replaced, and on a new fence', () => {
    const book = createStructuredOptionPickBook()
    observe(book, reporting('ask'))
    const first = pickMode(book, 'full-access')
    pickMode(book, 'accept-edits')
    settleStructuredOptionPick(book, first, false)
    expect(structuredPermissionPickStands(book, reporting('ask'), 1)).toBe(true)
    const latest = pickMode(book, 'auto')
    settleStructuredOptionPick(book, latest, false)
    expect(structuredPermissionPickStands(book, reporting('ask'), 1)).toBe(false)
    pickMode(book, 'auto')
    resetStructuredOptionPickBook(book)
    expect(structuredPermissionPickStands(book, reporting('ask'), 1)).toBe(false)
  })
})
