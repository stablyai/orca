import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { buildWorkspaceSessionPayload } from './workspace-session'

describe("the window's saved session", () => {
  it("never carries main's resume outcomes, which are live state", () => {
    const store = createTestStore()
    store.setState({
      terminalPaneResumeOutcomesByPaneKey: {
        'tab-1:leaf-1': { ptyId: 'pty-1', ptyGeneration: 3, outcome: 'restored' }
      }
    })

    const saved = JSON.stringify(buildWorkspaceSessionPayload(store.getState()))

    expect(saved).not.toContain('resumeOutcome')
    expect(saved).not.toContain('restored')
  })
})
