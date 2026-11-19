import { describe, expect, it } from 'vitest'
import { getRuntimeCommitMessageSettings } from './runtime-git-client-context'

describe('getRuntimeCommitMessageSettings', () => {
  it('sends a blank default agent as null so older remote hosts accept it', () => {
    const settings = getRuntimeCommitMessageSettings(
      { kind: 'environment', environmentId: 'wsl-ubuntu' },
      { defaultTuiAgent: 'blank' }
    )

    expect(settings.defaultTuiAgent).toBeNull()
  })
})
