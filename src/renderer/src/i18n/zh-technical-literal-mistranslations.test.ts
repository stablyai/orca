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

// #12881 — the status bar provider usage surfaces settle on 使用情况, matching the Kimi/MiniMax
// entries that already used it. Scope is those surfaces, not the word "usage" everywhere: a
// measured volume ("Daily usage" 每日使用量, "Refresh Claude usage" 刷新 Claude 使用量) stays 使用量.
describe('zh provider usage wording (#12881)', () => {
  it('renders every "<Brand> Usage" label as "<Brand> 使用情况"', () => {
    for (const [key, brand] of [
      // status bar item menu
      ['3885eb74d8', 'Claude'],
      ['c0909c686e', 'Codex'],
      ['c1df0d67ec', 'Gemini'],
      ['antigravityUsage', 'Antigravity'],
      ['8c86cd77b0', 'OpenCode Go'],
      ['5e59007df4', 'Kimi'],
      ['3bbf140864', 'MiniMax'],
      ['grokUsageMenu', 'Grok'],
      // Settings > Appearance search index — mirrors the menu labels
      ['9dc15020d7', 'Claude'],
      ['54b1acf24f', 'Codex'],
      ['5bfb874d05', 'Gemini'],
      ['antigravityUsageTitle', 'Antigravity'],
      ['bc046e7899', 'OpenCode Go'],
      ['3a6c028ea8', 'Kimi'],
      ['0f08f6b483', 'MiniMax'],
      ['f8e2a1c4b6', 'Grok'],
      // Settings > Accounts search index
      ['733f9e2a93', 'MiniMax'],
      ['f4a8c2e1b7', 'Grok (xAI)']
    ]) {
      expect(findByKey(zh, key), key).toBe(`${brand} 使用情况`)
    }
  })

  it('leaves the Kimi and Moonshot search keywords untransliterated', () => {
    expect(findByKey(zh, '40e5c3c285')).toBe('kimi') // not 基米
    expect(findByKey(zh, '35565867cb')).toBe('moonshot') // not 登月计划 ("moon landing programme")
  })

  it('keeps the status bar toggle descriptions on 使用情况', () => {
    expect(findByKey(zh, 'antigravityUsageDescription')).toBe(
      '在状态栏中显示 Antigravity 订阅使用情况。'
    )
    expect(findByKey(zh, 'e7d1b0f3a5')).toBe('显示来自 Grok CLI OAuth 的 Grok 每周额度使用情况。')
    expect(findByKey(zh, 'grokToggleDescription')).toBe(
      '通过 Grok CLI 登录后显示 Grok 订阅额度使用情况。'
    )
    expect(findByKey(zh, 'antigravityToggleDescription')).toBe(
      '显示当前工作区的 Antigravity 订阅使用情况。'
    )
  })

  it('uses one wording for the "Open <Brand> usage details" labels', () => {
    for (const [key, brand] of [
      ['fda8146810', 'Kimi'],
      ['629251f4b6', 'OpenCode Go'],
      ['d2375976eb', 'Gemini'],
      ['06741a2f3d', 'MiniMax'],
      ['antigravityUsageDetails', 'Antigravity'],
      ['grokUsageAria', 'Grok']
    ]) {
      expect(findByKey(zh, key), key).toBe(`打开 ${brand} 使用详情`)
    }
  })
})
