import { describe, expect, it } from 'vitest'
import type { KeybindingFileDiagnostic } from '../../../../../shared/keybindings/types'
import { normalizeStoredWebOverrides } from './web-keybinding-normalization'

describe('normalizeStoredWebOverrides', () => {
  it('skips a stored unbind for the retired workspace.delete action without a warning', () => {
    const diagnostics: KeybindingFileDiagnostic[] = []
    const overrides = normalizeStoredWebOverrides(
      { 'workspace.delete': [], 'not.an.action': [] },
      'keybindings',
      diagnostics
    )

    expect(overrides).toEqual({})
    expect(diagnostics.map((diagnostic) => diagnostic.actionId)).toEqual(['not.an.action'])
  })
})
