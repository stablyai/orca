import { describe, expect, it } from 'vitest'
import {
  REPO_PATH_PLACEHOLDER,
  WORKTREE_PATH_PLACEHOLDER,
  spliceTemplateValue
} from './custom-agent-template-insert'

describe('spliceTemplateValue', () => {
  it('inserts at a collapsed caret and returns the caret after the insert', () => {
    const result = spliceTemplateValue('--dir ', { start: 6, end: 6 }, REPO_PATH_PLACEHOLDER)
    expect(result.value).toBe('--dir {repoPath}')
    expect(result.caret).toBe('--dir '.length + REPO_PATH_PLACEHOLDER.length)
  })

  it('replaces the selected span', () => {
    const result = spliceTemplateValue('--dir OLD', { start: 6, end: 9 }, WORKTREE_PATH_PLACEHOLDER)
    expect(result.value).toBe('--dir {worktreePath}')
    expect(result.caret).toBe('--dir '.length + WORKTREE_PATH_PLACEHOLDER.length)
  })

  it('normalizes a reversed selection', () => {
    const result = spliceTemplateValue('abcd', { start: 3, end: 1 }, 'X')
    expect(result.value).toBe('aXd')
    expect(result.caret).toBe(2)
  })

  it('appends when the selection is out of range', () => {
    const result = spliceTemplateValue('abc', { start: 99, end: 99 }, '!')
    expect(result.value).toBe('abc!')
    expect(result.caret).toBe(4)
  })

  it('treats a negative start as end-of-value', () => {
    const result = spliceTemplateValue('abc', { start: -1, end: -1 }, '!')
    expect(result.value).toBe('abc!')
    expect(result.caret).toBe(4)
  })
})
