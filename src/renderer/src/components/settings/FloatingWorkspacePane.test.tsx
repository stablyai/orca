import { describe, expect, it } from 'vitest'
import { getFloatingWorkspaceDirectoryInputValue } from './FloatingWorkspacePane'

describe('getFloatingWorkspaceDirectoryInputValue', () => {
  it('shows the resolved app-owned default when no directory is configured', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredDirectory: '',
        defaultFloatingWorkspacePath:
          '/Users/example/Library/Application Support/Orca/floating-workspace',
        directoryDraft: null
      })
    ).toBe('/Users/example/Library/Application Support/Orca/floating-workspace')
  })

  it('keeps the editable draft visible while the user clears the field', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredDirectory: '',
        defaultFloatingWorkspacePath:
          '/Users/example/Library/Application Support/Orca/floating-workspace',
        directoryDraft: ''
      })
    ).toBe('')
  })

  it('prefers a configured custom directory over the default', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredDirectory: '~/notes',
        defaultFloatingWorkspacePath:
          '/Users/example/Library/Application Support/Orca/floating-workspace',
        directoryDraft: null
      })
    ).toBe('~/notes')
  })
})
