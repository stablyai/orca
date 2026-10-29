import { describe, expect, it } from 'vitest'
import { invalidPluginErrorMessage } from './plugin-error-presentation'

describe('invalid plugin error copy', () => {
  const schemaError = 'invalid manifest: engines.orca: must be at least >=1.4.245'

  it('asks the author to fix a dev folder, but never the user of an installed copy', () => {
    expect(invalidPluginErrorMessage(schemaError)).toBe(
      'orca-plugin.json is invalid. Fix it, then refresh plugins.'
    )
    expect(invalidPluginErrorMessage(schemaError, true)).toBe(
      "This version can't load in this Orca. Update or reinstall it."
    )
    expect(invalidPluginErrorMessage('invalid JSON in orca-plugin.json: x', true)).toBe(
      "This version can't load in this Orca. Update or reinstall it."
    )
    expect(invalidPluginErrorMessage('requires Orca >=9.0.0 (this is 1.4.0)', true)).toBe(
      'This plugin requires a different Orca version.'
    )
  })
})
