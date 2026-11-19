// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ layoutOwnerIsMain: false }))
const record = vi.hoisted(() => vi.fn())

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return flags.layoutOwnerIsMain
  }
}))
vi.mock('@/lib/agent-session/history/session-names/terminal-session-name-recording', () => ({
  recordTerminalTabRename: record
}))

describe.each([false, true])('tab rename with main owning layout: %s', (layoutOwnerIsMain) => {
  beforeEach(() => {
    vi.resetModules()
    record.mockClear()
    flags.layoutOwnerIsMain = layoutOwnerIsMain
  })

  it("records the tab's session name before the rename is applied", async () => {
    const { useAppStore } = await import('../index')
    useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug')
  })
})
