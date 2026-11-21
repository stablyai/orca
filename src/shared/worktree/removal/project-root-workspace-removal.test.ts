import { describe, expect, it } from 'vitest'
import { projectRootWorkspaceRemovalError } from './removal'

describe('project root workspace removal refusal', () => {
  it('names setup-delete and how to list setups', () => {
    const message = projectRootWorkspaceRemovalError().message
    expect(message.startsWith('Cannot delete the project root workspace')).toBe(true)
    expect(message).toContain('orca project setup-delete --setup <setup-id>')
    expect(message).toContain('orca project setups')
  })
})
