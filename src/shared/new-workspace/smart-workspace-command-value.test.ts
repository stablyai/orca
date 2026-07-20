import { describe, expect, it } from 'vitest'
import { resolveSmartWorkspaceCommandValue } from './smart-workspace-command-value'

describe('resolveSmartWorkspaceCommandValue', () => {
  it('prioritizes a ClickUp row for an explicit ClickUp source intent', () => {
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'typed-name',
        rows: [
          { kind: 'use-name', value: 'typed-name' },
          { kind: 'clickup', value: 'clickup:task-1' }
        ],
        isQueryStale: false,
        sourceIntent: 'clickup'
      })
    ).toBe('clickup:task-1')
  })
})
