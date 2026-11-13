import { describe, expect, it } from 'vitest'
import { filterAvailableTaskProviders, normalizeTaskProviderSettings } from './task-providers'

describe('task providers', () => {
  it('keeps Backlog visible without provider credentials or a Git hosting CLI', () => {
    expect(
      filterAvailableTaskProviders(['backlog'], { gitlabInstalled: false, linearConnected: false })
    ).toEqual(['backlog'])
    expect(
      normalizeTaskProviderSettings({
        visibleTaskProviders: ['backlog'],
        defaultTaskSource: 'backlog'
      })
    ).toEqual({ visibleTaskProviders: ['backlog'], defaultTaskSource: 'backlog' })
  })
})
