import { describe, expect, it } from 'vitest'
import { buildClickUpWorkspaceSource, getWorkspaceSourceName } from './workspace-source'

describe('buildClickUpWorkspaceSource', () => {
  const task = { id: '86abc123', name: 'Fix login', url: 'https://app.clickup.com/t/86abc123' }

  it('names a task by its custom id when it has one', () => {
    const source = buildClickUpWorkspaceSource({ ...task, customId: 'ENG-7' })

    expect(source.clickupIdentifier).toBe('ENG-7')
    expect(getWorkspaceSourceName(source).seedName).toMatch(/^ENG-7\b/i)
  })
})
