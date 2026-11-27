import { expect, it } from 'vitest'
import { getGitLabContextLineOldNumber } from './mr-inline-comment-position'

it('maps only context rows to their old coordinate within the declared hunks', () => {
  const diff = [
    '--- a/code.txt',
    '+++ b/code.txt',
    '@@ -1,7 +1,6 @@',
    ' one',
    '-remove-a',
    '-remove-b',
    ' context-after-delete',
    '-old',
    '+replacement-a',
    '+replacement-b',
    ' context-after-replace',
    ' last',
    '@@ -20 +19 @@',
    ' tail',
    '\\ No newline at end of file',
    ''
  ].join('\n')

  expect(
    [1, 2, 3, 4, 5, 6, 7, 18, 19, 20].map((line) => getGitLabContextLineOldNumber(diff, line))
  ).toEqual([1, 4, undefined, undefined, 6, 7, undefined, undefined, 20, undefined])
  expect(getGitLabContextLineOldNumber('@@ -0,0 +1,2 @@\n+first\n+second\n', 1)).toBeUndefined()
  expect(getGitLabContextLineOldNumber('@@ -1,2 +0,0 @@\n-first\n-second\n', 1)).toBeUndefined()
  expect(getGitLabContextLineOldNumber('@@ -1 +1 @@\n only\n extra\n', 2)).toBeUndefined()
  expect(getGitLabContextLineOldNumber('@@ -1 +1 @@\nbare\n context\n', 2)).toBeUndefined()
})
