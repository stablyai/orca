import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLinearWorkspaceLinkSummary } from './linear-workspace-link-summary'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('getLinearWorkspaceLinkSummary', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses complete singular and plural workspace messages', () => {
    getLinearWorkspaceLinkSummary(1)
    getLinearWorkspaceLinkSummary(2)

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.onboarding.IntegrationsStep.oneWorkspaceLinked',
      '{{count}} workspace linked. Add another workspace or replace a restricted key any time.',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.onboarding.IntegrationsStep.manyWorkspacesLinked',
      '{{count}} workspaces linked. Add another workspace or replace a restricted key any time.',
      { count: 2 }
    )
  })
})
