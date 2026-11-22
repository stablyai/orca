import { describe, expect, it } from 'vitest'
import { UiUpdateFields } from '../../rpc-contract/client-ui/client-ui-params'
import { omitPairingLocalUiFields } from './pairing-local-ui-fields'

describe('desktop-only moved-to-WSL list fields at the paired boundary', () => {
  // A paired host's strict ui.set rejects them, and a web client has no moved list to show.
  it('never leave a client, so its write still passes the host schema', () => {
    const update = {
      sidebarWidth: 300,
      wslMovedSectionCollapsed: true,
      hiddenWslMovedProjectKeys: []
    }
    expect(UiUpdateFields.safeParse(update).success).toBe(false)
    const sent = omitPairingLocalUiFields(update)
    expect(sent).toEqual({ sidebarWidth: 300 })
    expect(UiUpdateFields.safeParse(sent).success).toBe(true)
  })
})
