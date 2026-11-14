import { describe, expect, it } from 'vitest'
import { getWorkspaceIntentName } from './workspace-name'

describe('getWorkspaceIntentName', () => {
  it('does not treat an auto-generated slug as explicit user intent', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'issue-123-fix-navbar',
        workItem: {
          type: 'issue',
          number: 456,
          title: 'Make importer handle archived rows'
        }
      })
    ).toEqual({
      displayName: 'Issue 456 Make Importer Handle',
      seedName: 'issue-456-make-importer-handle'
    })
  })
})
