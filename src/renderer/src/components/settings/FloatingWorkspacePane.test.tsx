import { describe, expect, it } from 'vitest'
import { getFloatingWorkspaceDirectoryInputValue } from './FloatingWorkspacePane'

describe('getFloatingWorkspaceDirectoryInputValue', () => {
  it('shows the resolved app-owned default', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        resolvedFloatingWorkspacePath:
          '/Users/example/Library/Application Support/Orca/floating-workspace'
      })
    ).toBe('/Users/example/Library/Application Support/Orca/floating-workspace')
  })

  it('shows the main-resolved trusted custom directory', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        resolvedFloatingWorkspacePath: '/Users/example/notes'
      })
    ).toBe('/Users/example/notes')
  })
})
