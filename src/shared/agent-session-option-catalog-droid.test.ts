import { describe, expect, it } from 'vitest'
import { getAgentModelProbeSpec } from './agent-model-probe-spec'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { DROID_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-droid'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'

const HELP = `Model details:
  - Auto Model: supports reasoning: No; supported: [none]; default: none
  - Opus 5: supports reasoning: Yes; supported: [off, low, medium, high]; default: high
`

function snapshot(mode: 'draft' | 'live', models = DROID_SESSION_OPTION_CATALOG.models) {
  return buildNativeChatSessionOptionSnapshot({
    catalog: DROID_SESSION_OPTION_CATALOG,
    models,
    record: createNativeChatSessionOptionRecord('droid'),
    mode,
    modelLabel: 'Model'
  })
}

describe('droid session option catalog', () => {
  it('is registered for the droid agent', () => {
    expect(getAgentSessionOptionCatalog('droid')).toBe(DROID_SESSION_OPTION_CATALOG)
  })

  // Interactive droid ignores unknown flags silently (verified against v0.191.1),
  // so a seeded model would present a choice the launch drops without erroring.
  it('seeds no models and shows no pill until the host probe lands', () => {
    expect(DROID_SESSION_OPTION_CATALOG.models).toEqual([])
    expect(snapshot('draft')).toEqual([])
    expect(snapshot('live')).toEqual([])
  })

  it('emits no launch flags, since only `droid exec` accepts a model', () => {
    expect(DROID_SESSION_OPTION_CATALOG.modelApply.launchArgs).toBeUndefined()
    expect(resolveAgentSessionOptionLaunch('droid', { model: 'Opus 5' })).toEqual({
      args: [],
      appliedValues: {}
    })
  })

  it('reports the model as settable only after the session starts', () => {
    const models = [{ id: 'Opus 5', label: 'Opus 5', options: [] }]
    const draftModel = snapshot('draft', models)[0]
    expect(draftModel).toMatchObject({
      id: 'model',
      settable: false,
      disabledReason: 'available-after-session-start'
    })
    // No fabricated current value: droid's model comes from account settings.
    expect(draftModel?.kind.type === 'select' ? draftModel.kind.currentValue : null).toBeUndefined()
  })

  it('routes a live change into droid\u2019s own /model selector', () => {
    const liveModel = snapshot('live', [{ id: 'Opus 5', label: 'Opus 5', options: [] }])[0]
    expect(liveModel).toMatchObject({ settable: true, action: { type: 'agent-picker' } })
    expect(DROID_SESSION_OPTION_CATALOG.modelApply.midSession).toEqual({
      kind: 'agent-picker',
      command: '/model'
    })
  })

  it('offers no reasoning-effort rows the interactive CLI could not apply', () => {
    const models = [{ id: 'Opus 5', label: 'Opus 5', options: [] }]
    expect(snapshot('live', models).map(({ id }) => id)).toEqual(['model'])
  })

  it('discovers models through the same probe the catalog documents', () => {
    const spec = getAgentModelProbeSpec('droid')
    expect(spec?.modelSource).toBe('dynamic')
    expect(spec?.modelDiscovery?.binary).toBe('droid')
    expect(DROID_SESSION_OPTION_CATALOG.listModels?.command).toBe(
      `droid ${spec?.modelDiscovery?.args.join(' ')}`
    )
    expect(DROID_SESSION_OPTION_CATALOG.listModels?.parse(HELP)).toEqual([
      { id: 'Auto Model', label: 'Auto Model', options: [] },
      { id: 'Opus 5', label: 'Opus 5', options: [] }
    ])
  })

  it('keeps droid out of the commit-message agent registry', () => {
    expect(getAgentModelProbeSpec('droid')?.models).toEqual([])
    expect('buildArgs' in (getAgentModelProbeSpec('droid') ?? {})).toBe(false)
  })
})
