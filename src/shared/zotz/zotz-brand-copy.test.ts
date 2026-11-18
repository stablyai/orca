import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _setZotzBrandCopyDisabledForTests,
  applyZotzBrandToCatalog,
  applyZotzBrandToCopy
} from './zotz-brand-copy'

describe('Zotz brand copy', () => {
  beforeEach(() => _setZotzBrandCopyDisabledForTests(false))
  afterEach(() => _setZotzBrandCopyDisabledForTests(true))

  it('renames the app but keeps the official Orca Mobile app and lowercase identifiers', () => {
    expect(applyZotzBrandToCopy("Orca couldn't open orca.dev; run `orca serve`.")).toBe(
      "Zotz couldn't open orca.dev; run `orca serve`."
    )
    expect(applyZotzBrandToCopy('Scan with Orca Mobile or the Orca mobile app.')).toBe(
      'Scan with Orca Mobile or the Orca mobile app.'
    )
    expect(applyZotzBrandToCopy('Escanéalo con la aplicación móvil de Orca en Orca.')).toBe(
      'Escanéalo con la aplicación móvil de Orca en Zotz.'
    )
    expect(applyZotzBrandToCopy('Actualiza la app de Orca en este teléfono.')).toBe(
      'Actualiza la app de Orca en este teléfono.'
    )
  })

  it('keeps Orca inside paths and identifiers', () => {
    expect(applyZotzBrandToCopy('Restart Orca after editing ~/Orca/config or C:\\Orca\\x.')).toBe(
      'Restart Zotz after editing ~/Orca/config or C:\\Orca\\x.'
    )
    expect(applyZotzBrandToCopy('Paste this link in Orca: Settings → Remote Orca Servers.')).toBe(
      'Paste this link in Zotz: Settings → Remote Zotz Servers.'
    )
  })

  it('leaves the zotz namespace of a catalog alone', () => {
    expect(
      applyZotzBrandToCatalog({
        menu: { quit: 'Quit Orca' },
        zotz: { version: 'Zotz 1.0 (Orca 1.4)' }
      })
    ).toEqual({ menu: { quit: 'Quit Zotz' }, zotz: { version: 'Zotz 1.0 (Orca 1.4)' } })
  })
})
