import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import {
  deriveAgentDefaultOptions,
  deriveDefaultComboboxValue,
  deriveStaleDefault,
  isDefaultUnset
} from './agent-default-options'
import {
  buildLocalCatalogSnapshot,
  buildReadyCustom,
  buildRepairCustom
} from './agent-catalog-snapshot.fixture'

const CUSTOM_ID = 'custom-agent:codex:one' as CustomTuiAgentId

describe('deriveAgentDefaultOptions', () => {
  it('lists enabled built-ins in canonical order', () => {
    const options = deriveAgentDefaultOptions(buildLocalCatalogSnapshot({}))
    const ids = options.map((option) => option.id)
    expect(ids[0]).toBe('claude')
    expect(ids.indexOf('codex')).toBeGreaterThan(ids.indexOf('claude'))
  })

  it('places an enabled custom immediately below its base', () => {
    const options = deriveAgentDefaultOptions(
      buildLocalCatalogSnapshot({
        customAgents: [buildReadyCustom({ id: CUSTOM_ID, base: 'codex' })]
      })
    )
    const codexIndex = options.findIndex((option) => option.id === 'codex')
    expect(options[codexIndex + 1]).toMatchObject({ id: CUSTOM_ID, baseAgent: 'codex' })
  })

  it('omits a disabled built-in and a base-disabled custom', () => {
    const options = deriveAgentDefaultOptions(
      buildLocalCatalogSnapshot({
        disabledAgents: ['codex'] as TuiAgent[],
        customAgents: [buildReadyCustom({ id: CUSTOM_ID, base: 'codex' })]
      })
    )
    expect(options.some((option) => option.id === 'codex')).toBe(false)
    // A custom whose base is disabled cannot launch, so it is never offered.
    expect(options.some((option) => option.id === CUSTOM_ID)).toBe(false)
  })

  it('omits an individually disabled custom', () => {
    const options = deriveAgentDefaultOptions(
      buildLocalCatalogSnapshot({
        disabledAgents: [CUSTOM_ID] as TuiAgent[],
        customAgents: [buildReadyCustom({ id: CUSTOM_ID, base: 'codex' })]
      })
    )
    expect(options.some((option) => option.id === CUSTOM_ID)).toBe(false)
  })
})

describe('deriveDefaultComboboxValue', () => {
  it('maps auto and repair-null both to Auto', () => {
    expect(deriveDefaultComboboxValue(buildLocalCatalogSnapshot({ defaultAgent: 'auto' }))).toBe(
      'auto'
    )
    expect(deriveDefaultComboboxValue(buildLocalCatalogSnapshot({ defaultAgent: null }))).toBe(
      'auto'
    )
  })

  it('passes through blank and a concrete id', () => {
    expect(deriveDefaultComboboxValue(buildLocalCatalogSnapshot({ defaultAgent: 'blank' }))).toBe(
      'blank'
    )
    expect(deriveDefaultComboboxValue(buildLocalCatalogSnapshot({ defaultAgent: 'claude' }))).toBe(
      'claude'
    )
  })
})

describe('isDefaultUnset', () => {
  it('is true only for a repair-generated null default', () => {
    expect(isDefaultUnset(buildLocalCatalogSnapshot({ defaultAgent: null }))).toBe(true)
    expect(isDefaultUnset(buildLocalCatalogSnapshot({ defaultAgent: 'auto' }))).toBe(false)
    expect(isDefaultUnset(buildLocalCatalogSnapshot({ defaultAgent: 'claude' }))).toBe(false)
  })
})

describe('deriveStaleDefault', () => {
  it('returns null for auto, blank, and an enabled current default', () => {
    expect(deriveStaleDefault(buildLocalCatalogSnapshot({ defaultAgent: 'auto' }))).toBeNull()
    expect(deriveStaleDefault(buildLocalCatalogSnapshot({ defaultAgent: 'blank' }))).toBeNull()
    expect(deriveStaleDefault(buildLocalCatalogSnapshot({ defaultAgent: 'claude' }))).toBeNull()
  })

  it('surfaces a disabled built-in default for repair', () => {
    const stale = deriveStaleDefault(
      buildLocalCatalogSnapshot({ defaultAgent: 'codex', disabledAgents: ['codex'] as TuiAgent[] })
    )
    expect(stale).toMatchObject({ id: 'codex', baseAgent: 'codex' })
    expect(stale?.label).toBeTruthy()
  })

  it('surfaces a repair-required custom default instead of falling through to Auto', () => {
    const stale = deriveStaleDefault(
      buildLocalCatalogSnapshot({
        defaultAgent: CUSTOM_ID,
        customAgents: [buildRepairCustom({ id: CUSTOM_ID, base: 'codex', label: 'Broken Codex' })]
      })
    )
    expect(stale).toMatchObject({ id: CUSTOM_ID, baseAgent: 'codex', label: 'Broken Codex' })
  })

  it('falls back to a generic label for a repair-required default with an unsafe label', () => {
    const stale = deriveStaleDefault(
      buildLocalCatalogSnapshot({
        defaultAgent: CUSTOM_ID,
        customAgents: [buildRepairCustom({ id: CUSTOM_ID, base: 'codex', label: null })]
      })
    )
    expect(stale).toMatchObject({ id: CUSTOM_ID, baseAgent: 'codex' })
    expect(stale?.label).toBeTruthy()
  })

  it('returns no stale descriptor for a repair row without a proven base', () => {
    const stale = deriveStaleDefault(
      buildLocalCatalogSnapshot({
        defaultAgent: CUSTOM_ID,
        customAgents: [buildRepairCustom({ id: CUSTOM_ID, base: undefined, label: 'Broken' })]
      })
    )
    expect(stale).toBeNull()
  })

  it('surfaces a tombstoned custom default with its stored label and base', () => {
    const stale = deriveStaleDefault(
      buildLocalCatalogSnapshot({
        defaultAgent: CUSTOM_ID,
        deletedCustomAgents: [
          { id: CUSTOM_ID, baseAgent: 'codex', label: 'Gone Codex', deletedAt: 1 }
        ]
      })
    )
    expect(stale).toMatchObject({ id: CUSTOM_ID, baseAgent: 'codex', label: 'Gone Codex' })
  })
})
