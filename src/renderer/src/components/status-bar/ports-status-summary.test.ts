import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspacePortAriaLabel, getWorkspacePortTooltipLabel } from './ports-status-summary'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('ports status summary copy', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses complete singular and plural aria-label keys', () => {
    getWorkspacePortAriaLabel(1)
    getWorkspacePortAriaLabel(2)

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortAriaLabel',
      'Ports, {{workspaceCount}} workspace port',
      { workspaceCount: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsAriaLabel',
      'Ports, {{workspaceCount}} workspace ports',
      { workspaceCount: 2 }
    )
  })

  it('keeps the optional external count inside complete tooltip messages', () => {
    getWorkspacePortTooltipLabel(1, 0)
    getWorkspacePortTooltipLabel(2, 3)

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortTooltip',
      'Ports — {{workspaceCount}} workspace port',
      { workspaceCount: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsWithExternalTooltip',
      'Ports — {{workspaceCount}} workspace ports · {{externalCount}} external',
      { workspaceCount: 2, externalCount: 3 }
    )
  })
})
