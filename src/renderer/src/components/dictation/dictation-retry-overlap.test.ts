import { describe, expect, it } from 'vitest'
import { trimLandedOverlap } from './dictation-retry-overlap'

describe('trimLandedOverlap', () => {
  it.each([
    {
      name: 'drops the words that already landed',
      landed: 'The login page sends you to the root after sign in.',
      retried:
        'The login page sends you to the root after sign in. It should go back to the page you came from.',
      expected: { text: 'It should go back to the page you came from.', matched: true }
    },
    {
      name: 'ignores case and punctuation differences in the re-decode',
      landed: 'the login page sends you to the root after sign-in',
      retried:
        'The login page sends you to the Root, after sign in. Check where returnTo gets dropped.',
      expected: { text: 'Check where returnTo gets dropped.', matched: true }
    },
    {
      name: 'picks the match nearest where the landed text ends',
      landed: 'go back to the page. Then go back to the page',
      retried: 'Go back to the page. Then go back to the page. Done.',
      expected: { text: 'Done.', matched: true }
    },
    {
      name: 'inserts nothing when everything already landed',
      landed: 'It should go back to the page you came from.',
      retried: 'It should go back to the page you came from.',
      expected: { text: '', matched: true }
    },
    {
      name: 'inserts everything when nothing landed',
      landed: '',
      retried: ' Check where returnTo gets dropped. ',
      expected: { text: 'Check where returnTo gets dropped.', matched: true }
    },
    {
      name: 'inserts everything when the landed words are not found',
      landed: 'something entirely different was typed here',
      retried: 'The login page sends you to the root.',
      expected: { text: 'The login page sends you to the root.', matched: false }
    }
  ])('$name', ({ landed, retried, expected }) => {
    expect(trimLandedOverlap(landed, retried)).toEqual(expected)
  })
})
