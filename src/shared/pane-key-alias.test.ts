import { describe, expect, it } from 'vitest'
import { makePaneKey } from './stable-pane-id'
import { canRegisterPaneKeyAlias, isOpaqueRemintedPaneKey } from './pane-key-alias'

const CANONICAL = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const REMINTED = '$$MFRGGZDFMY:L$$'

describe('opaque reminted pane keys', () => {
  it('accepts the exact $$<base32>:L$$ remint form', () => {
    expect(isOpaqueRemintedPaneKey(REMINTED)).toBe(true)
    expect(canRegisterPaneKeyAlias(REMINTED, CANONICAL)).toBe(true)
  })

  it('rejects canonical keys, numeric keys with a different tab, and unmatched tokens', () => {
    expect(isOpaqueRemintedPaneKey(CANONICAL)).toBe(false)
    expect(canRegisterPaneKeyAlias(CANONICAL, CANONICAL)).toBe(false)
    expect(canRegisterPaneKeyAlias('tab-other:0', CANONICAL)).toBe(false)
    expect(canRegisterPaneKeyAlias('tab-1:0', CANONICAL)).toBe(true)
    expect(canRegisterPaneKeyAlias('$$not-a-token$$', CANONICAL)).toBe(false)
    expect(canRegisterPaneKeyAlias('nearest-pane', CANONICAL)).toBe(false)
    expect(canRegisterPaneKeyAlias(REMINTED, '$$ONXW2ZJAON:L$$')).toBe(false)
    expect(canRegisterPaneKeyAlias(REMINTED, 'tab-1:0')).toBe(false)
  })

  it('rejects oversized canonical destinations', () => {
    const oversizedPane = `${'x'.repeat(180)}:11111111-1111-4111-8111-111111111111`
    expect(canRegisterPaneKeyAlias(REMINTED, oversizedPane)).toBe(false)
  })
})
