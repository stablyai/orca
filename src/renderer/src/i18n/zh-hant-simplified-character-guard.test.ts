import { describe, expect, it } from 'vitest'

import zhHant from './locales/zh-Hant.json'

// Why: only characters that never appear in Traditional text; shared ones (行, 置, 框) would false-positive.
const SIMPLIFIED_ONLY_CHARACTERS = new Set(
  '们这说为个时开关闭设执运务环当发选择项创删复员终输显进对话档读写载线种网络页键错误动态库储'
)

function collectStrings(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === 'string') {
    out.push([path, node])
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectStrings(value, path ? `${path}.${key}` : key, out)
    }
  }
}

describe('zh-Hant catalog', () => {
  it('contains no Simplified-only characters', () => {
    const entries: [string, string][] = []
    collectStrings(zhHant, '', entries)
    const leaks = entries.filter(([, value]) =>
      [...value].some((char) => SIMPLIFIED_ONLY_CHARACTERS.has(char))
    )
    expect(leaks.map(([path]) => path)).toEqual([])
  })

  // Why: 計算機 / 製表符 are mainland terms; Taiwan UI copy uses 電腦 and 分頁.
  it('uses Taiwan terms for computer and tab', () => {
    const entries: [string, string][] = []
    collectStrings(zhHant, '', entries)
    expect(
      entries.filter(([, value]) => /計算機|製表符/.test(value)).map(([path]) => path)
    ).toEqual([])
  })

  it('keeps the Simplified Chinese option in its own script', () => {
    expect(zhHant.settings.appearance.language.chinese).toBe('中文（简体）')
    expect(zhHant.settings.appearance.language.chineseTraditional).toBe('中文（繁體）')
  })
})
