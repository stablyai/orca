import { describe, expect, it } from 'vitest'
import { joinSentences } from './sentence-joining'

describe('joining catalog sentences', () => {
  it('puts the stop after a closing mark that ends a Chinese sentence', () => {
    expect(
      joinSentences(['Option 键输入字符（安全的默认设置）', '选择"两个都"使用 Option 快捷键'])
    ).toBe('Option 键输入字符（安全的默认设置）。选择"两个都"使用 Option 快捷键')
  })

  it('adds nothing when the stop sits inside the closing mark', () => {
    expect(joinSentences(['（已完成。）', '下一句'])).toBe('（已完成。）下一句')
  })

  it('keeps a space after an ASCII-quoted path that ends in CJK text', () => {
    expect(joinSentences(["scandir '/Users/x/项目'", 'Next run in 1 hour.'])).toBe(
      "scandir '/Users/x/项目' Next run in 1 hour."
    )
  })

  it('skips empty sentences', () => {
    expect(joinSentences(['', '第一句', '', 'Second.'])).toBe('第一句。Second.')
  })
})
