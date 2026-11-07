// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'auto-1',
  title: 'Nightly',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'scheduled',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1
}

const history: SelectedAutomationRunHistoryOutcome = {
  automationId: 'auto-1',
  rowKey: null,
  ownerKey: null,
  authority: null,
  navigation: null,
  reloadToken: 0,
  runs: [run],
  notice: null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderRun(value: AutomationRun): void {
  act(() => {
    root.render(
      <AutomationRunDetailsPage
        automation={null}
        run={value}
        history={history}
        relativeNow={1}
        workspaceDisplay={null}
        viewState={null}
        canRerun={false}
        isRerunPending={false}
        onRerun={() => {}}
        onOpenWorkspace={() => {}}
        onBack={() => {}}
      />
    )
  })
}

describe('AutomationRunDetailsPage skipped setup', () => {
  it("says when the run's branch had different setup than the automation approved", () => {
    renderRun({ ...run, setupSkippedReason: 'setup-changed' })
    expect(container.textContent).toContain("Setup didn't run: this run's branch has different")
  })

  it('says nothing for a run whose setup was not skipped', () => {
    renderRun(run)
    expect(container.textContent).not.toContain("Setup didn't run")
  })
})
