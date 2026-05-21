import { describe, expect, it } from 'vitest'
import { getFloatingWorkspaceDirectoryInputValue } from './FloatingWorkspacePane'

describe('getFloatingWorkspaceDirectoryInputValue', () => {
  it('shows home shorthand for the default terminal directory', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '~',
        resolvedFloatingWorkspacePath: '/Users/example'
      })
    ).toBe('~')
  })

  it('shows home shorthand for legacy blank terminal directory settings', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '',
        resolvedFloatingWorkspacePath: '/Users/example'
      })
    ).toBe('~')
  })

  it('shows the main-resolved trusted custom directory', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '/Users/example/notes',
        resolvedFloatingWorkspacePath: '/Users/example/notes'
      })
    ).toBe('/Users/example/notes')
  })
})
