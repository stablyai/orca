/**
 * Issue #9574 — high-confidence Simplified Chinese semantic fixes.
 * Guards the anchor GH PR mistranslation and a sample of technical literals /
 * clear sense errors so bootstrap re-translation cannot silently regress them.
 */
import { describe, expect, it } from 'vitest'
import zh from './locales/zh.json'

function findByKey(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByKey(item, key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  const record = node as Record<string, unknown>
  if (typeof record[key] === 'string') {
    return record[key] as string
  }
  for (const value of Object.values(record)) {
    const found = findByKey(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

describe('zh technical literal / sense fixes (#9574)', () => {
  it('keeps GH PR as a technical literal (not 生长激素受体)', () => {
    expect(findByKey(zh, '1b91db7e14')).toBe('GH PR')
  })

  it('keeps CLI / product technical strings un-translated', () => {
    expect(findByKey(zh, 'fe119187bb')).toBe('--model sonnet')
    expect(findByKey(zh, '5c5b65044e')).toBe('pnpm install')
    expect(findByKey(zh, '5af8251002')).toBe('SCSS')
    expect(findByKey(zh, '97e96cc027')).toBe('/goal')
    expect(findByKey(zh, 'f62ce91ade')).toBe('origin')
    expect(findByKey(zh, '79afc6772b')).toBe('orca.yaml')
  })

  it('uses the correct sense for short UI verbs/nouns', () => {
    expect(findByKey(zh, 'ac037cfac2')).toBe('移动') // Move, not 手机
    expect(findByKey(zh, '1b24a32d3a')).toBe('内存') // Memory, not 记忆
    expect(findByKey(zh, '8cde1a2fb0')).toBe('暂存') // Stage, not 阶段
    expect(findByKey(zh, 'af2b07bda5')).toBe('状态：{{value0}}') // State, not 州
    expect(findByKey(zh, 'e070e8aeba')).toBe('竖线') // Bar cursor
    expect(findByKey(zh, '52854a5608')).toBe('块状') // Block cursor
  })

  it('preserves brand names in product copy', () => {
    expect(findByKey(zh, '855a76343a')).toBe('从 Ghostty 导入')
    expect(findByKey(zh, '0a75e5e2fa')).toBe('创建 Hermes 自动化')
    expect(findByKey(zh, 'ff450194cd')).toBe('Kagi 私密会话链接')
  })
})
