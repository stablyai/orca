import { expect, it } from 'vitest'
import { extractTerminalFileLinkReadings, extractTerminalFileLinks } from './terminal-links'

it('ends a parenthesized file link before adjoining prose', () => {
  expect(extractTerminalFileLinks('수정본 (records/review/한글.docx)에 정리했어요.')).toEqual([
    {
      pathText: 'records/review/한글.docx',
      displayText: 'records/review/한글.docx',
      startIndex: 5,
      endIndex: 27,
      line: null,
      column: null
    }
  ])
})

it('balances filename parentheses before the wrapper closes', () => {
  expect(extractTerminalFileLinks('(src/(group)/한글(수정본).ts)text')).toEqual([
    {
      pathText: 'src/(group)/한글(수정본).ts',
      displayText: 'src/(group)/한글(수정본).ts',
      startIndex: 1,
      endIndex: 23,
      line: null,
      column: null
    }
  ])
})

it('offers both the wrapped target and the longer literal filename for host verification', () => {
  const { links, guesses } = extractTerminalFileLinkReadings('(src/report.docx)에')
  expect(links.map((link) => link.pathText)).toEqual(['src/report.docx'])
  expect(guesses.map((link) => link.pathText)).toContain('src/report.docx)에')
})
