import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { GitPane, getGitPaneSearchEntries, SourceControlGroupOrderSetting } from './GitPane'
import { matchesSettingsSearch } from './settings-search'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findButton(node: unknown, label: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'button' && entry.props.children === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`button not found: ${label}`)
  }
  return found
}

describe('GitPane', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  it('renders Source Control group order in Git settings', () => {
    const markup = renderToStaticMarkup(
      <GitPane
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        displayedGitUsername=""
      />
    )

    expect(markup).toContain('Source Control Group Order')
    expect(markup).toContain('Changes First')
    expect(markup).toContain('Staged First')
    expect(markup).toContain('Untracked First')
  })

  it('updates Source Control group order only when the selected option changes', () => {
    const updateSettings = vi.fn()
    const element = SourceControlGroupOrderSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        sourceControlGroupOrder: 'changes-first'
      },
      updateSettings
    })

    const stagedFirst = findButton(element, 'Staged First')
    const onStagedFirstClick = stagedFirst.props.onClick as () => void
    onStagedFirstClick()
    expect(updateSettings).toHaveBeenCalledWith({ sourceControlGroupOrder: 'staged-first' })

    updateSettings.mockClear()
    const changesFirst = findButton(element, 'Changes First')
    const onChangesFirstClick = changesFirst.props.onClick as () => void
    onChangesFirstClick()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('includes Source Control group order search metadata', () => {
    expect(matchesSettingsSearch('staged', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('group order', getGitPaneSearchEntries())).toBe(true)
  })
})
