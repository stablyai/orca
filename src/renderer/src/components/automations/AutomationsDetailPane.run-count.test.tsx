// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { makeAutomation } from './automations-page-fixtures'

let root: Root | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function renderRunsTab(historyUnavailable: boolean): Promise<HTMLButtonElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <AutomationsDetailPane
        selected={makeAutomation()}
        selectedExternal={null}
        selectedExternalRunPage={null}
        selectedRuns={[]}
        selectedRunsNotice={
          historyUnavailable
            ? { message: 'Server update required', recovery: 'update-server', severity: 'failure' }
            : null
        }
        activePaneTab="runs"
        relativeNow={0}
        externalActionKey={null}
        selectedRepoDisplayName="Orca"
        selectedRepoDefaultBaseRef={null}
        selectedWorkspaceName="Workspace"
        selectedHostEntry={null}
        hostLabelById={new Map()}
        selectedRunNowAvailability={null}
        worktreeMap={new Map()}
        fetchExternalAutomationRuns={vi.fn()}
        onActivePaneTabChange={vi.fn()}
        onClearExternalRunPage={vi.fn()}
        requestExternalAction={vi.fn()}
        openExternalRunPage={vi.fn()}
        openEditExternalDialog={vi.fn()}
        runNow={vi.fn()}
        openEditDialog={vi.fn()}
        toggleAutomation={vi.fn()}
        requestDeleteAutomation={vi.fn()}
        openAutomationRunPage={vi.fn()}
        onBackToList={vi.fn()}
        recoverSelectedRuns={vi.fn()}
      />
    )
  })
  const runsTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
    tab.textContent?.includes('Runs')
  )
  if (!runsTab) {
    throw new Error('Runs tab was not rendered')
  }
  return runsTab
}

describe('AutomationsDetailPane run count', () => {
  it('does not report zero when run history is unavailable', async () => {
    expect((await renderRunsTab(true)).textContent?.trim()).toBe('Runs')
  })

  it('reports zero when the host answered with an empty history', async () => {
    expect((await renderRunsTab(false)).textContent).toContain('0')
  })
})
