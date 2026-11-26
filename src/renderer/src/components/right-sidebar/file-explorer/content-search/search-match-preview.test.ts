import { describe, expect, it } from 'vitest'
import type { SearchMatch } from '../../../../../../shared/file-search/code-search-types'
import { getSearchMatchPreviewParts } from './search-match-preview'

function previewBefore(lineContent: string, word: string): string {
  const column = lineContent.indexOf(word) + 1
  const match: SearchMatch = { line: 1, column, matchLength: word.length, lineContent }
  return getSearchMatchPreviewParts(match).before
}

describe('getSearchMatchPreviewParts', () => {
  it('opens the shortened context on a whole word or character in any script', () => {
    expect(previewBefore('Please review the meeting notes and the schedule.', 'schedule')).toBe(
      '…and the '
    )
    expect(previewBefore('배포 전에 데이터베이스 마이그레이션 스크립트를 검토합니다', '검토')).toBe(
      '…스크립트를 '
    )
    expect(previewBefore('Статья описывает подробности реализации нового модуля', 'модуля')).toBe(
      '…нового '
    )
    expect(previewBefore('emoji test xxxxxxxxxxxxxxxxx🎉🎉🎉🎉🎉🎉🎉 here', 'here')).toBe(
      '…🎉🎉🎉🎉🎉 '
    )
  })

  it('keeps context up to the cut in scripts written without spaces between words', () => {
    expect(previewBefore('我们需要在部署之前检查数据库迁移脚本，然后运行 target', 'target')).toBe(
      '…据库迁移脚本，然后运行 '
    )
    expect(
      previewBefore('今日は天気が良いので、公園に散歩に行きました。そこでtarget', 'target')
    ).toBe('…散歩に行きました。そこで')
    expect(previewBefore('ข้อความภาษาไทยไม่มีการเว้นวรรคระหว่างคำ ok target', 'target')).toBe(
      '…ะหว่างคำ ok '
    )
    expect(previewBefore('អត្ថបទខ្មែរមិនមានដកឃ្លាទេ ok target', 'target')).toBe('…ដកឃ្លាទេ ok ')
    expect(previewBefore('ꦲꦏ꧀ꦱꦫꦗꦮꦲꦏ꧀ꦱꦫꦗꦮꦲꦏ꧀ꦱꦫ ok target', 'target')).toBe('…ꦫꦗꦮꦲꦏ꧀ꦱꦫ ok ')
  })

  it('never splits an emoji variation selector, keycap or astral letter at the cut', () => {
    expect(previewBefore('a long line of text ❤️love abcdef target', 'target')).toBe(
      '…love abcdef '
    )
    expect(previewBefore('a long line 𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇 𝐈𝐉 target', 'target')).toBe('…𝐈𝐉 ')
    expect(previewBefore('a long line of text 1️⃣2️⃣3️⃣ abc target', 'target')).toBe('…2️⃣3️⃣ abc ')
  })
})
