import { describe, expect, it } from 'vitest'
import {
  resolveAddressBarEscape,
  type AddressBarEscapeOutcome,
  type AddressBarSuggestionsState
} from './browser-address-bar-escape'

const PAGE = 'example.com/docs'
const TYPED = 'exa'
const PREVIEW = { typedQuery: TYPED, selection: { start: 3, end: 3, direction: 'none' as const } }

type BarState = { suggestions: AddressBarSuggestionsState; draft: string }

function pressEscapeUntilLeave(start: BarState): AddressBarEscapeOutcome['kind'][] {
  const kinds: AddressBarEscapeOutcome['kind'][] = []
  let state = start
  for (let press = 0; press < 5; press++) {
    const outcome = resolveAddressBarEscape({ ...state, committedAddress: PAGE })
    kinds.push(outcome.kind)
    switch (outcome.kind) {
      case 'restore-typed-query':
        state = {
          suggestions: { kind: 'open' },
          draft: outcome.preview.typedQuery
        }
        break
      case 'close-suggestions':
        state = { ...state, suggestions: { kind: 'closed' } }
        break
      case 'revert-to-page':
        state = { ...state, draft: outcome.committedAddress }
        break
      case 'leave-for-page':
        return kinds
    }
  }
  return kinds
}

describe('resolveAddressBarEscape walks Chrome omnibox Escape presses', () => {
  it.each<[string, BarState, AddressBarEscapeOutcome['kind'][]]>([
    [
      'dropdown open on a previewed suggestion',
      { suggestions: { kind: 'previewing', preview: PREVIEW }, draft: 'https://example.com/' },
      ['restore-typed-query', 'close-suggestions', 'revert-to-page', 'leave-for-page']
    ],
    [
      'dropdown open on typed text',
      { suggestions: { kind: 'open' }, draft: TYPED },
      ['close-suggestions', 'revert-to-page', 'leave-for-page']
    ],
    [
      'edited, dropdown closed',
      { suggestions: { kind: 'closed' }, draft: TYPED },
      ['revert-to-page', 'leave-for-page']
    ],
    [
      'unchanged, dropdown closed',
      { suggestions: { kind: 'closed' }, draft: PAGE },
      ['leave-for-page']
    ],
    [
      'unchanged, zero-suggest dropdown open',
      { suggestions: { kind: 'open' }, draft: PAGE },
      ['close-suggestions', 'leave-for-page']
    ]
  ])('%s', (_name, start, expected) => {
    expect(pressEscapeUntilLeave(start)).toEqual(expected)
  })

  it('hands back the saved preview and the committed address it acts on', () => {
    expect(
      resolveAddressBarEscape({
        suggestions: { kind: 'previewing', preview: PREVIEW },
        draft: 'https://example.com/',
        committedAddress: PAGE
      })
    ).toEqual({ kind: 'restore-typed-query', preview: PREVIEW })
    expect(
      resolveAddressBarEscape({
        suggestions: { kind: 'closed' },
        draft: TYPED,
        committedAddress: PAGE
      })
    ).toEqual({ kind: 'revert-to-page', committedAddress: PAGE })
  })
})
