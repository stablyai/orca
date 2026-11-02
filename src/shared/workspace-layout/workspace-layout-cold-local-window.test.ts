import { expect, it, vi } from 'vitest'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { coldInput } from './workspace-layout-cold-local.test-fixture'
import { GIT_KEY } from './workspace-layout-session.test-fixture'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
it('leaves window browser hydration to its existing owner', () => {
  const stored = coldInput('browser', 100)
  const context = nameBasedLoadContext()
  const mintId = vi.fn(context.mintId)
  const loaded = loadWorkspaceLayout('local', stored, { ...context, mintId })
  expect(loaded.layout.workspaces[GIT_KEY].tabs.map((tab) => tab.kind)).toEqual(['terminal'])
  expect(mintId.mock.calls.filter(([seed]) => seed.startsWith('browser-tab:'))).toEqual([])
  expect(Object.keys(loaded.facts.browserTabs[GIT_KEY])).toHaveLength(100)
})
