import { describe, expect, it } from 'vitest'
import { MUSE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-muse'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

const option = (id: string) => {
  const found = (MUSE_SESSION_OPTION_CATALOG.unknownModelOptions ?? []).find(
    (candidate) => candidate.id === id
  )
  if (!found) {
    throw new Error(`Muse catalog must define a ${id} option`)
  }
  return found
}

describe('muse session option catalog', () => {
  it('seeds the four meta-provider models with wonder 1.0 the default', () => {
    expect(MUSE_SESSION_OPTION_CATALOG.models.map((model) => model.id)).toEqual([
      'muse-wonder-1.0',
      'muse-wonder-full-1.0',
      'muse-spark-1.3',
      'muse-spark-1.2'
    ])
    expect(MUSE_SESSION_OPTION_CATALOG.models.find((model) => model.isDefault)?.id).toBe(
      'muse-wonder-1.0'
    )
    for (const model of MUSE_SESSION_OPTION_CATALOG.models) {
      expect(model.options.map((candidate) => candidate.id)).toEqual([
        'effort',
        'permissionProfile'
      ])
    }
  })

  it('switches models mid-session through /model with an inline id', () => {
    const midSession = MUSE_SESSION_OPTION_CATALOG.modelApply.midSession
    expect(midSession?.kind).toBe('command')
    if (midSession?.kind !== 'command') {
      throw new Error('Muse model midSession must stay a slash command')
    }
    expect(midSession.build('muse-wonder-1.0')).toBe('/model muse-wonder-1.0')
    expect(midSession.pickerCommand).toBe('/model')
  })

  it('offers every /effort tier including none', () => {
    const kind = option('effort').kind
    expect(kind.type).toBe('select')
    if (kind.type !== 'select') {
      throw new Error('Muse effort must stay a select')
    }
    expect(kind.choices.map((choice) => choice.value)).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra'
    ])
    expect(kind.defaultValue).toBe('high')
  })

  it('switches effort mid-session through the /effort slash command', () => {
    const midSession = option('effort').apply.midSession
    expect(midSession?.kind).toBe('command')
    if (midSession?.kind !== 'command') {
      throw new Error('Muse effort midSession must stay a slash command')
    }
    expect(midSession.build('low')).toBe('/effort low')
  })

  it('offers the four built-in permission profiles with colon-prefixed ids', () => {
    const kind = option('permissionProfile').kind
    expect(kind.type).toBe('select')
    if (kind.type !== 'select') {
      throw new Error('Muse permissionProfile must stay a select')
    }
    expect(kind.choices.map((choice) => choice.value)).toEqual([
      ':read-only',
      ':ask-me',
      ':auto-review',
      ':unrestricted'
    ])
    expect(kind.choices.map((choice) => choice.label)).toEqual([
      'Read only',
      'Ask me',
      'Auto-review',
      'Unrestricted'
    ])
  })

  it('opens /permissions mid-session since the command takes no argument', () => {
    const midSession = option('permissionProfile').apply.midSession
    expect(midSession).toEqual({ kind: 'agent-picker', command: '/permissions', delivery: 'type' })
  })

  it('keeps launch args for worker starts', () => {
    expect(option('effort').apply.launchArgs?.('ultra')).toEqual(['--reasoning-effort', 'ultra'])
    expect(MUSE_SESSION_OPTION_CATALOG.modelApply.launchArgs?.('muse-wonder-1.0')).toEqual([
      '--model',
      'muse-wonder-1.0'
    ])
  })

  it('sends no permission flag at launch, so a picked model never changes posture', () => {
    expect(option('permissionProfile').apply.launchArgs).toBeUndefined()
    expect(resolveAgentSessionOptionLaunch('muse', { model: 'muse-spark-1.3' }).args).not.toContain(
      '--permission-profile'
    )
  })

  it('resolves an explicit worker model and effort to launch flags', () => {
    expect(
      resolveAgentSessionOptionLaunch('muse', { model: 'muse-spark-1.3', effort: 'low' }, [], false)
    ).toEqual({
      args: ['--model', 'muse-spark-1.3', '--reasoning-effort', 'low'],
      appliedValues: { model: 'muse-spark-1.3', effort: 'low' }
    })
  })

  it('emits no flags without an explicitly picked model', () => {
    expect(resolveAgentSessionOptionLaunch('muse', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })
})
