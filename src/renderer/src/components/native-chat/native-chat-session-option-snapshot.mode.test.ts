import { describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from '../../../../shared/native-chat-session-option-state'
import {
  buildNativeChatSessionOptionSnapshot,
  flattenNativeChatSessionOptionRecord
} from './native-chat-session-option-snapshot'
import { createSessionOptionAppliers } from './native-chat-session-option-apply'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { readClaudePermissionModeFromTerminalScreen } from './claude-terminal-session-options'

const catalog = getAgentSessionOptionCatalog('claude')!

function build(
  mode: 'draft' | 'live',
  options?: { record?: NativeChatSessionOptionRecord; agentArgs?: string | null }
) {
  return buildNativeChatSessionOptionSnapshot({
    catalog,
    models: catalog.models,
    record: options?.record ?? createNativeChatSessionOptionRecord('claude'),
    mode,
    agentArgs: options?.agentArgs
  })
}

function permissionModeChoices(agentArgs?: string | null, record?: NativeChatSessionOptionRecord) {
  const descriptor = build('live', { agentArgs, record }).find((d) => d.id === 'permissionMode')
  if (descriptor?.kind.type !== 'select') {
    throw new Error('expected permissionMode to be a select descriptor')
  }
  return descriptor.kind
}

describe('permission mode descriptor', () => {
  it('appears even when no model is tracked yet', () => {
    expect(build('live').find((d) => d.id === 'permissionMode')).toBeDefined()
  })

  it('is settable in a live session via the key menu', () => {
    const descriptor = build('live').find((d) => d.id === 'permissionMode')
    expect(descriptor?.settable).toBe(true)
    expect(descriptor?.action).toBeUndefined()
  })

  it('is settable in draft because it has launch args', () => {
    expect(build('draft').find((d) => d.id === 'permissionMode')?.settable).toBe(true)
  })

  it('carries the mode category so it sorts with modes', () => {
    expect(build('live').find((d) => d.id === 'permissionMode')?.category).toBe('mode')
  })

  it('never composes session options into the model value', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.sessionValues.permissionMode = { value: 'plan', source: 'reported' }
    expect(flattenNativeChatSessionOptionRecord(record, 'sonnet')).toEqual({ model: 'sonnet' })
  })
})

describe('bypass permissions gated on the launch flag', () => {
  it('offers bypass as a normal choice when agent args carry --dangerously-skip-permissions', () => {
    const bypass = permissionModeChoices('--dangerously-skip-permissions').choices.find(
      (choice) => choice.value === 'bypassPermissions'
    )
    expect(bypass?.unavailable).toBeUndefined()
  })

  it('marks bypass unavailable when agent args do not carry the flag', () => {
    const bypass = permissionModeChoices('--model sonnet').choices.find(
      (choice) => choice.value === 'bypassPermissions'
    )
    expect(bypass?.unavailable).toEqual({ action: 'open-agent-permissions-setting' })
  })

  it('leaves the other four choices selectable when bypass is unavailable', () => {
    const others = permissionModeChoices(null).choices.filter(
      (choice) => choice.value !== 'bypassPermissions'
    )
    expect(others).toHaveLength(4)
    expect(others.every((choice) => choice.unavailable === undefined)).toBe(true)
  })

  it('leaves the other four choices selectable when bypass is available', () => {
    const others = permissionModeChoices('--dangerously-skip-permissions').choices.filter(
      (choice) => choice.value !== 'bypassPermissions'
    )
    expect(others).toHaveLength(4)
    expect(others.every((choice) => choice.unavailable === undefined)).toBe(true)
  })

  it('reports bypassPermissions as the current value when the flag is present and nothing was reported', () => {
    expect(permissionModeChoices('--dangerously-skip-permissions').currentValue).toBe(
      'bypassPermissions'
    )
  })

  it('lets a reported mode win over the launch-args inference', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.sessionValues.permissionMode = { value: 'plan', source: 'reported' }
    expect(permissionModeChoices('--dangerously-skip-permissions', record).currentValue).toBe(
      'plan'
    )
  })
})

describe('an observed bypass mode is proof of the grant, even with empty launch args', () => {
  it('does not mark the bypass choice unavailable when the tracked mode is bypassPermissions', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.sessionValues.permissionMode = { value: 'bypassPermissions', source: 'reported' }
    const bypass = permissionModeChoices(null, record).choices.find(
      (choice) => choice.value === 'bypassPermissions'
    )
    expect(bypass?.unavailable).toBeUndefined()
  })

  it('still marks bypass unavailable when the tracked mode is a different mode and launch args are empty', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.sessionValues.permissionMode = { value: 'plan', source: 'reported' }
    const bypass = permissionModeChoices(null, record).choices.find(
      (choice) => choice.value === 'bypassPermissions'
    )
    expect(bypass?.unavailable).toEqual({ action: 'open-agent-permissions-setting' })
  })

  it('reproduces the reported bug end-to-end: real status line, empty launch args, bypass selectable', () => {
    const permissionMode = readClaudePermissionModeFromTerminalScreen(
      '> \n▶▶ bypass permissions on (shift+tab to cycle)'
    )
    expect(permissionMode).toBe('bypassPermissions')
    const record = createNativeChatSessionOptionRecord('claude')
    applyNativeChatReportedSessionOptions(record, { permissionMode: permissionMode! })
    const descriptor = permissionModeChoices(null, record)
    expect(descriptor.currentValue).toBe('bypassPermissions')
    const bypass = descriptor.choices.find((choice) => choice.value === 'bypassPermissions')
    expect(bypass?.unavailable).toBeUndefined()
  })
})

type ApplyModeCycle = (
  optionId: string,
  value: SessionOptionValue
) => Promise<{ outcome: 'applied' | 'unavailable' | 'unknown'; detail: string }>

describe('applying a session-scoped option', () => {
  function appliers(
    record: NativeChatSessionOptionRecord,
    applyModeCycle: ApplyModeCycle | undefined
  ) {
    return createSessionOptionAppliers({
      mode: 'live',
      catalog,
      getModels: () => catalog.models,
      getRecord: () => record,
      dispatchCommand: () => undefined,
      applyModeCycle,
      persist: () => {},
      publish: () => [],
      clearModelTruth: () => {},
      setTrackedValue: (optionId, value, source) => {
        record.sessionValues[optionId] = { value, source }
        return null
      }
    })
  }

  it('routes a cycle-key option to the mode-cycle handler', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    const seen: string[] = []
    await appliers(record, async (optionId, value) => {
      seen.push(`${optionId}=${String(value)}`)
      return { outcome: 'applied', detail: 'Set to plan.' }
    }).setOption('permissionMode', 'plan')
    expect(seen).toEqual(['permissionMode=plan'])
    expect(record.sessionValues.permissionMode).toEqual({ value: 'plan', source: 'applied' })
  })

  it('surfaces a launch-only bypass as a clear error', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    await expect(
      appliers(record, async () => ({
        outcome: 'unavailable',
        detail: "bypassPermissions is not in this session's cycle; saw plan."
      })).setOption('permissionMode', 'bypassPermissions')
    ).rejects.toThrow(/not in this session's cycle/i)
    expect(record.sessionValues.permissionMode).toBeUndefined()
  })

  it('does not record a value it could not verify', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    await expect(
      appliers(record, async () => ({
        outcome: 'unknown',
        detail: 'Could not read the current mode from the terminal.'
      })).setOption('permissionMode', 'plan')
    ).rejects.toThrow(/terminal/i)
    expect(record.sessionValues.permissionMode).toBeUndefined()
  })

  it('fails clearly when no mode-cycle handler is available', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    await expect(appliers(record, undefined).setOption('permissionMode', 'plan')).rejects.toThrow()
    expect(record.sessionValues.permissionMode).toBeUndefined()
  })
})

describe('draft-mode persistence of session-scoped options', () => {
  // Why: mirrors createNativeChatPtySessionOptions' real routing — a session
  // option goes to sessionValues, a model option goes under the tracked model.
  function trackingSetter(record: NativeChatSessionOptionRecord) {
    return (optionId: string, value: SessionOptionValue, source: 'applied' | 'dispatched') => {
      if (optionId === 'model') {
        record.model = { value, source }
        return typeof value === 'string' ? value : null
      }
      if (catalog.sessionOptions?.some((option) => option.id === optionId)) {
        record.sessionValues[optionId] = { value, source }
        return null
      }
      const modelId = typeof record.model?.value === 'string' ? record.model.value : null
      if (!modelId) {
        return null
      }
      record.valuesByModel[modelId] = {
        ...record.valuesByModel[modelId],
        [optionId]: { value, source }
      }
      return modelId
    }
  }

  it('does not persist a permissionMode selection', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'sonnet', source: 'applied' }
    const persist = vi.fn()
    await createSessionOptionAppliers({
      mode: 'draft',
      catalog,
      getModels: () => catalog.models,
      getRecord: () => record,
      dispatchCommand: () => undefined,
      persist,
      publish: () => [],
      clearModelTruth: () => {},
      setTrackedValue: trackingSetter(record)
    }).setOption('permissionMode', 'plan')
    expect(persist).not.toHaveBeenCalled()
    expect(record.sessionValues.permissionMode).toEqual({ value: 'plan', source: 'applied' })
  })

  it('still persists a model-scoped option', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'opus', source: 'applied' }
    const persist = vi.fn()
    await createSessionOptionAppliers({
      mode: 'draft',
      catalog,
      getModels: () => catalog.models,
      getRecord: () => record,
      dispatchCommand: () => undefined,
      persist,
      publish: () => [],
      clearModelTruth: () => {},
      setTrackedValue: trackingSetter(record)
    }).setOption('effort', 'high')
    expect(persist).toHaveBeenCalledWith('opus', 'effort', 'high')
  })
})

describe('bypass availability with extra launch args', () => {
  it('still offers bypass when the flag sits alongside other args', () => {
    const args = '--dangerously-skip-permissions --verbose'
    const bypass = permissionModeChoices(args).choices.find((c) => c.value === 'bypassPermissions')
    expect(bypass?.unavailable).toBeUndefined()
    expect(permissionModeChoices(args).currentValue).toBe('bypassPermissions')
  })

  it('withholds bypass when other args carry no bypass flag', () => {
    const bypass = permissionModeChoices('--model opus').choices.find(
      (c) => c.value === 'bypassPermissions'
    )
    expect(bypass?.unavailable).toEqual({ action: 'open-agent-permissions-setting' })
  })
})
