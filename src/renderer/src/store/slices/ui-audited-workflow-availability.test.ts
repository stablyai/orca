// @vitest-environment happy-dom
//
// Dedicated file (kept separate from ui.test.ts, which runs in the `node`
// environment and relies on `window === undefined` throughout) for the
// paired-web-client gating behavior of Audited Workflow's UI state/
// navigation, per audited-workflow-availability.ts. Needs a real `window`
// so isWebClientLocation()'s __ORCA_WEB_CLIENT__ marker check is exercised.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createSettingsSearchState } from './settings-search-state'
import type { AppState } from '../types'

type WebFlagWindow = { __ORCA_WEB_CLIENT__?: boolean; api?: { ui: { set: () => Promise<void> } } }

function setWebClientFlag(value: boolean | undefined): void {
  ;(window as unknown as WebFlagWindow).__ORCA_WEB_CLIENT__ = value
}

function createUIStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    worktreesByRepo: {},
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    markdownTocPanelWidth: 240,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    ...createSettingsSearchState(args[0]),
    ...createWorktreeNavHistorySlice(...(args as Parameters<typeof createWorktreeNavHistorySlice>)),
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  }))
}

function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return { ...getDefaultUIState(), ...overrides }
}

describe('Audited Workflow UI gating in the paired web client', () => {
  afterEach(() => {
    setWebClientFlag(undefined)
    ;(window as unknown as WebFlagWindow).api = undefined
  })

  it('openAuditedWorkflowPage does nothing in the paired web client, even with the flag enabled', () => {
    setWebClientFlag(true)
    const store = createUIStore()
    store.setState({
      settings: { experimentalAuditedWorkflow: true } as AppState['settings']
    })

    store.getState().openAuditedWorkflowPage()

    expect(store.getState().activeView).toBe('terminal')
  })

  it('openAuditedWorkflowPage still activates the view in the local Electron renderer with the flag enabled', () => {
    setWebClientFlag(undefined)
    const store = createUIStore()
    store.setState({
      settings: { experimentalAuditedWorkflow: true } as AppState['settings']
    })

    store.getState().openAuditedWorkflowPage()

    expect(store.getState().activeView).toBe('auditedWorkflow')
  })

  it('hydration falls back to terminal for a persisted auditedWorkflow view in the paired web client, even with the flag enabled', () => {
    ;(window as unknown as WebFlagWindow).api = { ui: { set: async () => {} } }
    setWebClientFlag(true)
    const store = createUIStore()
    store.setState({
      settings: { experimentalAuditedWorkflow: true } as AppState['settings']
    })

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ activeView: 'auditedWorkflow' }), 'startup')

    expect(store.getState().activeView).toBe('terminal')
  })

  it('hydration restores a persisted auditedWorkflow view in the local Electron renderer with the flag enabled', () => {
    ;(window as unknown as WebFlagWindow).api = { ui: { set: async () => {} } }
    setWebClientFlag(undefined)
    const store = createUIStore()
    store.setState({
      settings: { experimentalAuditedWorkflow: true } as AppState['settings']
    })

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ activeView: 'auditedWorkflow' }), 'startup')

    expect(store.getState().activeView).toBe('auditedWorkflow')
  })

  it('setActiveView("auditedWorkflow") resolves to terminal in the paired web client (restoration/sync bypass)', () => {
    setWebClientFlag(true)
    const store = createUIStore()

    store.getState().setActiveView('auditedWorkflow')

    expect(store.getState().activeView).toBe('terminal')
  })

  it('setActiveView("auditedWorkflow") remains auditedWorkflow in the local Electron renderer', () => {
    setWebClientFlag(undefined)
    const store = createUIStore()

    store.getState().setActiveView('auditedWorkflow')

    expect(store.getState().activeView).toBe('auditedWorkflow')
  })

  it('setActiveView leaves every other view unchanged in the paired web client', () => {
    setWebClientFlag(true)
    const store = createUIStore()
    const otherViews: AppState['activeView'][] = [
      'terminal',
      'settings',
      'tasks',
      'activity',
      'automations',
      'space',
      'skills',
      'mobile'
    ]

    for (const view of otherViews) {
      store.getState().setActiveView(view)
      expect(store.getState().activeView).toBe(view)
    }
  })
})
