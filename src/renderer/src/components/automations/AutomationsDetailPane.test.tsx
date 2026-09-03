// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { makeAutomation } from './automations-page-fixtures'
import type { AutomationPaneTab } from './automation-page-state'

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

function renderDetailPane(options: {
  activePaneTab?: AutomationPaneTab
  onActivePaneTabChange?: (tab: AutomationPaneTab) => void
  selected?: ReturnType<typeof makeAutomation> | null
  selectedExternal?: null
}) {
  const selected =
    options.selected !== undefined
      ? options.selected
      : makeAutomation({
          id: 'auto-1',
          name: 'Nightly Sync',
          prompt: 'Run sync'
        })
  const onActivePaneTabChange = options.onActivePaneTabChange ?? vi.fn()
  const activePaneTab = options.activePaneTab ?? 'overview'

  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationsDetailPane
          selected={selected}
          selectedExternal={null}
          selectedExternalRunPage={null}
          selectedRuns={[]}
          selectedRunsNotice={null}
          activePaneTab={activePaneTab}
          relativeNow={1000}
          externalActionKey={null}
          selectedRepoDisplayName="orca"
          selectedRepoDefaultBaseRef="main"
          selectedWorkspaceName="default"
          selectedHostEntry={null}
          hostLabelById={new Map()}
          selectedRunNowAvailability={null}
          worktreeMap={new Map()}
          fetchExternalAutomationRuns={async () => []}
          onActivePaneTabChange={onActivePaneTabChange}
          onClearExternalRunPage={() => undefined}
          requestExternalAction={() => undefined}
          openExternalRunPage={() => undefined}
          openEditExternalDialog={() => undefined}
          runNow={() => undefined}
          openEditDialog={() => undefined}
          toggleAutomation={() => undefined}
          requestDeleteAutomation={() => undefined}
          openAutomationRunPage={() => undefined}
          onBackToList={() => undefined}
          recoverSelectedRuns={() => undefined}
        />
      </TooltipProvider>
    )
  })

  return { onActivePaneTabChange }
}

describe('AutomationsDetailPane tab keyboard navigation', () => {
  it('switches from overview to runs tab on ArrowRight', () => {
    const onActivePaneTabChange = vi.fn()
    renderDetailPane({ activePaneTab: 'overview', onActivePaneTabChange })

    const rightArrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(rightArrow)

    expect(rightArrow.defaultPrevented).toBe(true)
    expect(onActivePaneTabChange).toHaveBeenCalledWith('runs')
  })

  it('switches from runs to overview tab on ArrowLeft', () => {
    const onActivePaneTabChange = vi.fn()
    renderDetailPane({ activePaneTab: 'runs', onActivePaneTabChange })

    const leftArrow = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(leftArrow)

    expect(leftArrow.defaultPrevented).toBe(true)
    expect(onActivePaneTabChange).toHaveBeenCalledWith('overview')
  })

  it('does nothing on ArrowLeft when already on overview', () => {
    const onActivePaneTabChange = vi.fn()
    renderDetailPane({ activePaneTab: 'overview', onActivePaneTabChange })

    const leftArrow = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(leftArrow)

    expect(leftArrow.defaultPrevented).toBe(false)
    expect(onActivePaneTabChange).not.toHaveBeenCalled()
  })

  it('does nothing on ArrowRight when already on runs', () => {
    const onActivePaneTabChange = vi.fn()
    renderDetailPane({ activePaneTab: 'runs', onActivePaneTabChange })

    const rightArrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(rightArrow)

    expect(rightArrow.defaultPrevented).toBe(false)
    expect(onActivePaneTabChange).not.toHaveBeenCalled()
  })

  it('ignores arrow keys when focused inside an input element', () => {
    const onActivePaneTabChange = vi.fn()
    renderDetailPane({ activePaneTab: 'overview', onActivePaneTabChange })

    const input = document.createElement('input')
    container.appendChild(input)
    input.focus()

    const rightArrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    input.dispatchEvent(rightArrow)

    expect(onActivePaneTabChange).not.toHaveBeenCalled()
  })

  it('calls onBackToList on Escape key press from detail view', () => {
    const onBackToList = vi.fn()
    const selected = makeAutomation({ id: 'auto-1' })

    act(() => {
      root.render(
        <TooltipProvider>
          <AutomationsDetailPane
            selected={selected}
            selectedExternal={null}
            selectedExternalRunPage={null}
            selectedRuns={[]}
            selectedRunsNotice={null}
            activePaneTab="overview"
            relativeNow={1000}
            externalActionKey={null}
            selectedRepoDisplayName="orca"
            selectedRepoDefaultBaseRef="main"
            selectedWorkspaceName="default"
            selectedHostEntry={null}
            hostLabelById={new Map()}
            selectedRunNowAvailability={null}
            worktreeMap={new Map()}
            fetchExternalAutomationRuns={async () => []}
            onActivePaneTabChange={() => undefined}
            onClearExternalRunPage={() => undefined}
            requestExternalAction={() => undefined}
            openExternalRunPage={() => undefined}
            openEditExternalDialog={() => undefined}
            runNow={() => undefined}
            openEditDialog={() => undefined}
            toggleAutomation={() => undefined}
            requestDeleteAutomation={() => undefined}
            openAutomationRunPage={() => undefined}
            onBackToList={onBackToList}
            recoverSelectedRuns={() => undefined}
          />
        </TooltipProvider>
      )
    })

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(escapeEvent)

    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(onBackToList).toHaveBeenCalledTimes(1)
  })
})
