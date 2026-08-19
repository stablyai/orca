import { describe, expect, it } from 'vitest'
import {
  buildPiRpcWorkerDispatchEnvelope,
  buildPiRpcWorkerLaunchCommand,
  buildPiRpcWorkerModelPrompt,
  parsePiRpcWorkerDispatchEnvelope,
  PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES,
  PI_RPC_WORKER_TASK_SPEC_MAX_BYTES
} from './pi-rpc-worker-launch'

const envelopeFields = {
  taskId: 'task_private',
  dispatchId: 'ctx_private',
  workerHandle: 'term_private',
  capability: 'dcap_private',
  taskSpec: 'Implement the requested change.',
  cliCommand: 'orca-ide' as const
}

describe('Pi RPC worker launch contract', () => {
  it('builds the platform CLI supervisor command with bounded model options', () => {
    expect(
      buildPiRpcWorkerLaunchCommand({
        cliCommand: 'orca',
        cliExecutable: '/trusted/bin/Orca',
        cliArgsPrefix: ['/trusted/app/out/cli/index.js'],
        platform: 'linux',
        model: 'openai/gpt-5.4',
        effort: 'high'
      })
    ).toBe(
      "'/trusted/bin/Orca' '/trusted/app/out/cli/index.js' 'pi-rpc-worker' '--model' 'openai/gpt-5.4' '--effort' 'high'"
    )
    expect(
      buildPiRpcWorkerLaunchCommand({
        cliCommand: 'orca-ide',
        cliExecutable: '/trusted/bin/orca-ide',
        platform: 'linux'
      })
    ).toBe("'/trusted/bin/orca-ide' 'pi-rpc-worker'")
    expect(
      buildPiRpcWorkerLaunchCommand({
        cliCommand: 'orca',
        cliExecutable: 'C:\\Trusted\\orca.exe',
        platform: 'win32'
      })
    ).toBe("& 'C:\\Trusted\\orca.exe' 'pi-rpc-worker'")
  })

  it('rejects invalid supervisor launch options without reflecting their values', () => {
    expect(() =>
      buildPiRpcWorkerLaunchCommand({
        cliCommand: 'orca',
        cliExecutable: '/trusted/bin/orca',
        platform: 'linux',
        effort: 'high'
      })
    ).toThrow('pi_rpc_worker_effort_requires_model')
    expect(() =>
      buildPiRpcWorkerLaunchCommand({
        cliCommand: 'orca',
        cliExecutable: '/trusted/bin/orca',
        platform: 'linux',
        model: `secret-${'x'.repeat(600)}`
      })
    ).toThrow('pi_rpc_worker_model_invalid')
  })

  it('serializes and parses the exact private versioned envelope', () => {
    const serialized = buildPiRpcWorkerDispatchEnvelope(envelopeFields)

    expect(serialized).toBe(
      '{"protocol":"orca.pi.rpc-worker.dispatch","version":1,"taskId":"task_private","dispatchId":"ctx_private","workerHandle":"term_private","capability":"dcap_private","taskSpec":"Implement the requested change.","cliCommand":"orca-ide"}'
    )
    expect(parsePiRpcWorkerDispatchEnvelope(serialized)).toEqual({
      protocol: 'orca.pi.rpc-worker.dispatch',
      version: 1,
      ...envelopeFields
    })
    expect(parsePiRpcWorkerDispatchEnvelope(`\u001b[200~${serialized}\u001b[201~\r`)).toEqual(
      expect.objectContaining(envelopeFields)
    )
  })

  it('rejects extra fields, unsupported versions, and envelope overflow', () => {
    const serialized = buildPiRpcWorkerDispatchEnvelope(envelopeFields)
    expect(() =>
      parsePiRpcWorkerDispatchEnvelope(serialized.replace('"version":1', '"version":2'))
    ).toThrow('pi_rpc_worker_dispatch_protocol_unsupported')
    expect(() =>
      parsePiRpcWorkerDispatchEnvelope(serialized.replace(/}$/, ',"extra":true}'))
    ).toThrow('pi_rpc_worker_dispatch_envelope_invalid')
    expect(() =>
      parsePiRpcWorkerDispatchEnvelope('x'.repeat(PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES + 1))
    ).toThrow('pi_rpc_worker_dispatch_envelope_too_large')
    expect(() =>
      buildPiRpcWorkerDispatchEnvelope({
        ...envelopeFields,
        taskSpec: 'x'.repeat(PI_RPC_WORKER_TASK_SPEC_MAX_BYTES + 1)
      })
    ).toThrow('pi_rpc_worker_dispatch_envelope_too_large')
  })

  it('builds a model-safe lifecycle prompt without host authority material', () => {
    const taskSpec = 'Update the parser and run its focused tests.'
    const prompt = buildPiRpcWorkerModelPrompt(taskSpec)

    expect(prompt).toContain(taskSpec)
    expect(prompt).toContain('supervisor-provided lifecycle tools')
    expect(prompt).toContain('orca_report_progress')
    expect(prompt).toContain('orca_ask_coordinator')
    expect(prompt).toContain('orca_escalate')
    expect(prompt).toContain('orca_worker_done exactly once')
    expect(prompt).not.toContain('orca orchestration')
    expect(prompt).not.toContain('ORCA_')
    expect(prompt).not.toContain('task_private')
    expect(prompt).not.toContain('ctx_private')
    expect(prompt).not.toContain('term_private')
    expect(prompt).not.toContain('dcap_private')
    expect(prompt).not.toContain('socket')
  })
})
