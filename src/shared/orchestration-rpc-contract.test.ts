import { describe, expect, it } from 'vitest'
import {
  isOrchestrationMutation,
  isRetiredOrchestrationMethod,
  orchestrationMigrationData
} from './orchestration-rpc-contract'

describe('orchestration RPC contract', () => {
  it.each([
    ['orchestration.runCreate', {}],
    ['orchestration.runUse', {}],
    ['orchestration.send', {}],
    ['orchestration.reply', {}],
    ['orchestration.taskCreate', {}],
    ['orchestration.taskUpdate', {}],
    ['orchestration.dispatch', {}],
    ['orchestration.workerStart', {}],
    ['orchestration.workerStop', {}],
    ['orchestration.workerAbandon', {}],
    ['orchestration.ask', {}],
    ['orchestration.gateCreate', {}],
    ['orchestration.gateResolve', {}],
    ['orchestration.reset', {}],
    ['orchestration.federationAttachStart', {}],
    ['orchestration.federationAck', {}],
    ['orchestration.federationImport', {}],
    ['orchestration.federationStop', {}],
    ['orchestration.collaborationPublish', {}],
    ['orchestration.collaborationCheckpoint', {}],
    ['orchestration.collaborationAck', {}],
    ['orchestration.collaborationConfigure', {}],
    ['orchestration.check', {}],
    ['orchestration.check', { wait: true }],
    ['orchestration.check', { unread: true }],
    ['orchestration.check', { peek: true, ack: 'delivery_1' }],
    ['orchestration.run', {}],
    ['orchestration.runStop', {}]
  ])('classifies %s as a mutation', (method, params) => {
    expect(isOrchestrationMutation(method, params)).toBe(true)
  })

  it.each([
    ['orchestration.runList', {}],
    ['orchestration.runShow', {}],
    ['orchestration.runCurrent', {}],
    ['orchestration.inbox', {}],
    ['orchestration.taskList', {}],
    ['orchestration.dispatchShow', {}],
    ['orchestration.gateList', {}],
    ['orchestration.workerShow', {}],
    ['orchestration.workerRead', {}],
    ['orchestration.federationPull', {}],
    ['orchestration.federationShow', {}],
    ['orchestration.federationRead', {}],
    ['orchestration.federationReadOutput', {}],
    ['orchestration.dispatch', { dryRun: true }],
    ['orchestration.check', { peek: true }],
    ['orchestration.check', { all: true }],
    ['orchestration.check', { unread: false }]
  ])('classifies %s as read-only', (method, params) => {
    expect(isOrchestrationMutation(method, params)).toBe(false)
  })

  it('keeps the retired scheduler methods explicit', () => {
    expect(isRetiredOrchestrationMethod('orchestration.run')).toBe(true)
    expect(isRetiredOrchestrationMethod('orchestration.runStop')).toBe(true)
    expect(isRetiredOrchestrationMethod('orchestration.runCreate')).toBe(false)
  })

  it('returns executable skill recovery without hardcoding a binary name', () => {
    expect(orchestrationMigrationData('client_contract_missing')).toMatchObject({
      reason: 'client_contract_missing',
      effectsApplied: false,
      requiredContractVersion: 1,
      guide: { topic: 'orchestration', full: true },
      nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
    })
  })
})
