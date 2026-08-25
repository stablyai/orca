import { describe, expect, it } from 'vitest'
import {
  buildClickUpTaskUrl,
  isResolvedClickUpTaskMatch,
  parseClickUpTaskInput,
  parseClickUpTaskUrl
} from './clickup-task-url'
import type { ClickUpTask } from './clickup-types'

describe('parseClickUpTaskUrl', () => {
  it('reads a native task URL', () => {
    expect(parseClickUpTaskUrl('https://app.clickup.com/t/86abc123')).toEqual({
      taskId: '86abc123',
      isCustomId: false,
      workspaceId: null,
      origin: 'https://app.clickup.com'
    })
  })

  it('reads the custom-id URL form as the custom id, not the Workspace', () => {
    expect(parseClickUpTaskUrl('https://app.clickup.com/t/9008123456/ORCA-42')).toEqual({
      taskId: 'ORCA-42',
      isCustomId: true,
      workspaceId: '9008123456',
      origin: 'https://app.clickup.com'
    })
  })

  it('ignores a trailing slug on a native task URL', () => {
    expect(parseClickUpTaskUrl('https://app.clickup.com/t/86abc123/task-title?view=detail')).toEqual(
      {
        taskId: '86abc123',
        isCustomId: false,
        workspaceId: null,
        origin: 'https://app.clickup.com'
      }
    )
  })

  it.each([
    ['a lookalike host', 'https://app.clickup.com.evil.example/t/86abc123'],
    ['plaintext http', 'http://app.clickup.com/t/86abc123'],
    ['embedded credentials', 'https://user:pass@app.clickup.com/t/86abc123'],
    ['an explicit port', 'https://app.clickup.com:8443/t/86abc123'],
    ['a missing id', 'https://app.clickup.com/t/'],
    ['an encoded path escape', 'https://app.clickup.com/t/%2Fetc'],
    ['a non-task route', 'https://app.clickup.com/9008123456/v/li/901300123456'],
    ['plain text', 'not a task']
  ])('rejects %s', (_label, input) => {
    expect(parseClickUpTaskUrl(input)).toBeNull()
  })
})

describe('parseClickUpTaskInput', () => {
  it('accepts a bare custom id', () => {
    expect(parseClickUpTaskInput('orca-42')?.taskId).toBe('ORCA-42')
  })

  it('rejects a bare native id, which cannot name its Workspace', () => {
    expect(parseClickUpTaskInput('86abc123')).toBeNull()
  })
})

describe('buildClickUpTaskUrl', () => {
  it('uses the custom-id route only when the Workspace is known', () => {
    expect(
      buildClickUpTaskUrl({ taskId: '86abc123', customId: 'ORCA-42', workspaceId: '9008123456' })
    ).toBe('https://app.clickup.com/t/9008123456/ORCA-42')
    expect(buildClickUpTaskUrl({ taskId: '86abc123', customId: 'ORCA-42' })).toBe(
      'https://app.clickup.com/t/86abc123'
    )
  })
})

describe('isResolvedClickUpTaskMatch', () => {
  const task = {
    id: '86abc123',
    customId: 'ORCA-42',
    workspaceId: '9008123456'
  } as ClickUpTask

  it('matches a custom-id URL against the task custom id', () => {
    const parsed = parseClickUpTaskUrl('https://app.clickup.com/t/9008123456/ORCA-42')
    expect(parsed && isResolvedClickUpTaskMatch(parsed, task)).toBe(true)
  })

  it('rejects a task from another Workspace', () => {
    const parsed = parseClickUpTaskUrl('https://app.clickup.com/t/9009999999/ORCA-42')
    expect(parsed && isResolvedClickUpTaskMatch(parsed, task)).toBe(false)
  })
})
