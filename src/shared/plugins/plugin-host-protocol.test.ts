import { describe, expect, it } from 'vitest'
import {
  pluginWorkerParentMessageSchema,
  pluginWorkerReadySchema,
  pluginWorkerTaskSourceResultSchema
} from './plugin-host-protocol'

describe('task source protocol messages', () => {
  it('accepts an invokeTaskSource parent message', () => {
    const parsed = pluginWorkerParentMessageSchema.safeParse({
      type: 'invokeTaskSource',
      callId: 0,
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toMatchObject({
      type: 'invokeTaskSource',
      callId: 0,
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })
  })

  it('rejects a method outside the closed task source method set', () => {
    const parsed = pluginWorkerParentMessageSchema.safeParse({
      type: 'invokeTaskSource',
      callId: 0,
      sourceId: 'azure-boards',
      method: 'deleteEverything'
    })

    expect(parsed.success).toBe(false)
  })

  it('carries registered task source ids on ready', () => {
    const parsed = pluginWorkerReadySchema.safeParse({
      type: 'ready',
      commands: [],
      taskSources: ['azure-boards']
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.taskSources).toEqual(['azure-boards'])
  })

  it('accepts a task source result from the worker', () => {
    const parsed = pluginWorkerTaskSourceResultSchema.safeParse({
      type: 'taskSourceResult',
      callId: 0,
      ok: true,
      value: { ok: true, data: { items: [], nextCursor: null } }
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.value).toEqual({
      ok: true,
      data: { items: [], nextCursor: null }
    })
  })
})
