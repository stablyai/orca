import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { getDefaultUIState } from '../../../../shared/constants'
import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  persistedUIWriteFieldsToWireUpdate
} from './persisted-ui-write-baseline'

describe('window pane persistence', () => {
  it('hydrates unresolved views and includes local pane changes in the persisted writer', () => {
    const store = createTestStore()
    const ui = getDefaultUIState()
    store.getState().hydratePersistedUI(ui)
    const baseline = capturePersistedUIWriteBaseline(store.getState())
    store.setState({ activeWorktreeId: 'missing-host-workspace' })
    store.getState().createUnifiedTab('missing-host-workspace', 'terminal', {
      executionHostId: 'ssh:offline',
      entityId: 'live-session'
    })
    store.getState().initializeWindowPanes()
    const layout = store.getState().windowPaneLayout
    const wire = persistedUIWriteFieldsToWireUpdate(
      diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(store.getState()), baseline)
    )
    expect(wire).toHaveProperty('windowPaneLayout', layout)
    const restored = createTestStore()
    restored.getState().hydratePersistedUI({ ...ui, ...wire })
    expect(restored.getState().windowPaneLayout).toEqual(layout)
    expect(Object.values(restored.getState().windowPaneLayout!.views)[0].executionHostId).toBe(
      'ssh:offline'
    )
    expect(omitPairingLocalUiFields(wire)).not.toHaveProperty('windowPaneLayout')
  })
})
