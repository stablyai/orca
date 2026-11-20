// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome/ui-chrome-types'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'

const panelMounts = vi.hoisted(() => ({ files: 0, agents: 0 }))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { activeWorkspaceKey: string | null }) => unknown) =>
    selector({ activeWorkspaceKey: 'repo:1' })
}))

vi.mock('./file-explorer/panel/FileExplorer', async () => {
  const { useState } = await import('react')
  return {
    default: function FileExplorerStub() {
      const [generation] = useState(() => {
        panelMounts.files += 1
        return panelMounts.files
      })
      return <div>files-panel-{generation}</div>
    }
  }
})

vi.mock('./ai-vault/panel/AiVaultSidebarPanel', async () => {
  const { useState } = await import('react')
  return {
    default: function AgentsStub() {
      const [generation] = useState(() => {
        panelMounts.agents += 1
        return panelMounts.agents
      })
      return <div>agents-panel-{generation}</div>
    }
  }
})

vi.mock('./checks-panel/ChecksPanel', () => ({
  default: function ChecksStub() {
    return <div>checks-panel</div>
  }
}))

afterEach(() => {
  cleanup()
  panelMounts.files = 0
  panelMounts.agents = 0
})

function Harness({ initialTab }: { initialTab: ActiveRightSidebarTab }) {
  const [effectiveTab, setEffectiveTab] = useState(initialTab)
  return (
    <>
      <button type="button" onClick={() => setEffectiveTab('explorer')}>
        show-files
      </button>
      <button type="button" onClick={() => setEffectiveTab('vault')}>
        show-agents
      </button>
      <button type="button" onClick={() => setEffectiveTab('checks')}>
        show-checks
      </button>
      <RightSidebarPanelContent
        effectiveTab={effectiveTab}
        rightSidebarOpen
        focusVaultSearch={false}
        onVaultSearchFocusHandled={() => undefined}
      />
    </>
  )
}

async function selectTab(
  name: 'show-files' | 'show-agents' | 'show-checks',
  panel: string
): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name }))
  expect(await screen.findByText(panel)).toBeVisible()
}

function expectHiddenPanel(text: string): void {
  const panel = screen.getByText(text, { hidden: true })
  expect(panel.closest('[hidden]')).not.toBeNull()
  expect(panel).not.toBeVisible()
}

describe('RightSidebarPanelContent retained Files and Agents panels', () => {
  it('keeps a visited Files panel mounted while another tab is selected', async () => {
    render(<Harness initialTab="explorer" />)
    expect(await screen.findByText('files-panel-1')).toBeVisible()

    await selectTab('show-checks', 'checks-panel')

    expectHiddenPanel('files-panel-1')
    await selectTab('show-files', 'files-panel-1')
    expect(panelMounts.files).toBe(1)
  })

  it('keeps a visited Agents panel mounted while another tab is selected', async () => {
    render(<Harness initialTab="vault" />)
    expect(await screen.findByText('agents-panel-1')).toBeVisible()

    await selectTab('show-checks', 'checks-panel')

    expectHiddenPanel('agents-panel-1')
    await selectTab('show-agents', 'agents-panel-1')
    expect(panelMounts.agents).toBe(1)
  })

  it('keeps both Files and Agents mounted after each has been opened', async () => {
    render(<Harness initialTab="explorer" />)
    expect(await screen.findByText('files-panel-1')).toBeVisible()

    await selectTab('show-agents', 'agents-panel-1')
    expectHiddenPanel('files-panel-1')

    await selectTab('show-checks', 'checks-panel')
    expectHiddenPanel('files-panel-1')
    expectHiddenPanel('agents-panel-1')

    await selectTab('show-files', 'files-panel-1')
    expectHiddenPanel('agents-panel-1')
    expect(panelMounts.files).toBe(1)
    expect(panelMounts.agents).toBe(1)
  })

  it('does not mount Files until that tab is opened', async () => {
    render(<Harness initialTab="checks" />)
    expect(await screen.findByText('checks-panel')).toBeVisible()
    expect(screen.queryByText('files-panel-1', { hidden: true })).toBeNull()
    expect(panelMounts.files).toBe(0)
  })

  it('unmounts Checks when Files is selected', async () => {
    render(<Harness initialTab="checks" />)
    expect(await screen.findByText('checks-panel')).toBeVisible()

    await selectTab('show-files', 'files-panel-1')

    expect(screen.queryByText('checks-panel', { hidden: true })).toBeNull()
    expect(panelMounts.files).toBe(1)
  })
})
