// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { ContributedPluginTaskSource } from '@/store/slices/plugin-task-sources-slice-contract'
import type { SmartWorkspaceNameSelection } from './smart-workspace-name-field-model'

const storeMocks: { state: { pluginTaskSources: ContributedPluginTaskSource[] } } = {
  state: { pluginTaskSources: [] }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMocks.state) => unknown) => selector(storeMocks.state)
}))

const { SelectionIcon } = await import('./smart-workspace-source-row-content')

afterEach(() => {
  cleanup()
  storeMocks.state.pluginTaskSources = []
})

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+'
const BOARDS: ContributedPluginTaskSource = {
  pluginKey: 'nssf.azure-boards',
  sourceId: 'azure-boards',
  title: 'Azure Boards',
  iconDataUrl: ICON
}
const SELECTION: SmartWorkspaceNameSelection = {
  kind: 'plugin',
  label: '3621 Something broke',
  pluginKey: 'nssf.azure-boards',
  sourceId: 'azure-boards'
}

const maskedIcon = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.plugin-task-source-icon')

describe('SelectionIcon for a contributed source', () => {
  it("draws the contributing plugin's own icon", () => {
    storeMocks.state.pluginTaskSources = [BOARDS]

    const { container } = render(<SelectionIcon selection={SELECTION} />)

    expect(maskedIcon(container)).toHaveStyle({ '--plugin-task-source-icon': `url("${ICON}")` })
  })

  it('paints that icon from the surrounding text colour rather than its own', () => {
    storeMocks.state.pluginTaskSources = [BOARDS]

    const { container } = render(<SelectionIcon selection={SELECTION} />)

    expect(maskedIcon(container)).toHaveClass('bg-current')
  })

  it('falls back to the generic glyph when the contributing plugin is gone', () => {
    const { container } = render(<SelectionIcon selection={SELECTION} />)

    expect(maskedIcon(container)).toBeNull()
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('falls back to the generic glyph when the source ships no icon', () => {
    storeMocks.state.pluginTaskSources = [{ ...BOARDS, iconDataUrl: undefined }]

    const { container } = render(<SelectionIcon selection={SELECTION} />)

    expect(maskedIcon(container)).toBeNull()
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('does not borrow another contributed source icon', () => {
    storeMocks.state.pluginTaskSources = [{ ...BOARDS, sourceId: 'other-board' }]

    const { container } = render(<SelectionIcon selection={SELECTION} />)

    expect(maskedIcon(container)).toBeNull()
  })
})
