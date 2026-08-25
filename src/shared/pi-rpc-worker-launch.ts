import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from './agent-prompt-injection'
import { buildShellCommandFromArgv, resolveStartupShell } from './tui-agent-startup-shell'

export const PI_RPC_WORKER_DISPATCH_PROTOCOL = 'orca.pi.rpc-worker.dispatch' as const
export const PI_RPC_WORKER_DISPATCH_VERSION = 1 as const

export const PI_RPC_WORKER_TASK_SPEC_MAX_BYTES = 256 * 1024
export const PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES = 512 * 1024

const PI_RPC_WORKER_ID_MAX_BYTES = 256
const PI_RPC_WORKER_HANDLE_MAX_BYTES = 512
const PI_RPC_WORKER_CAPABILITY_MAX_BYTES = 2 * 1024
const PI_RPC_WORKER_LAUNCH_OPTION_MAX_BYTES = 512

export type PiRpcWorkerCliCommand = 'orca' | 'orca-ide' | 'orca-dev'

export type PiRpcWorkerDispatchEnvelope = {
  protocol: typeof PI_RPC_WORKER_DISPATCH_PROTOCOL
  version: typeof PI_RPC_WORKER_DISPATCH_VERSION
  taskId: string
  dispatchId: string
  workerHandle: string
  capability: string
  taskSpec: string
  cliCommand: PiRpcWorkerCliCommand
}

export type PiRpcWorkerLaunchOptions = {
  model?: string
  effort?: string
}

/**
 * Builds the fresh supervisor command. Model and effort are host-selected,
 * bounded launch options; they never travel in the private dispatch envelope
 * or in the model-visible task prompt.
 */
export function buildPiRpcWorkerLaunchCommand(args: {
  cliCommand: PiRpcWorkerCliCommand
  cliExecutable: string
  cliArgsPrefix?: readonly string[]
  platform: NodeJS.Platform
  model?: string
  effort?: string
}): string {
  const model = normalizeLaunchOption('model', args.model)
  const effort = normalizeLaunchOption('effort', args.effort)
  if (effort && !model) {
    throw new Error('pi_rpc_worker_effort_requires_model')
  }
  assertBoundedNonEmpty('cliExecutable', args.cliExecutable, 4_096)
  const cliArgsPrefix = args.cliArgsPrefix ?? []
  if (cliArgsPrefix.length > 4) {
    throw new Error('pi_rpc_worker_cli_args_invalid')
  }
  for (const value of cliArgsPrefix) {
    assertBoundedNonEmpty('cli_args', value, 4_096)
  }
  const argv = [
    args.cliExecutable,
    ...cliArgsPrefix,
    'pi-rpc-worker',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : [])
  ]
  return buildShellCommandFromArgv(argv, resolveStartupShell(args.platform))
}

/** Serializes the only host-private input accepted by a fresh Pi RPC worker. */
export function buildPiRpcWorkerDispatchEnvelope(
  args: Omit<PiRpcWorkerDispatchEnvelope, 'protocol' | 'version'>
): string {
  assertBoundedNonEmpty('taskId', args.taskId, PI_RPC_WORKER_ID_MAX_BYTES)
  assertBoundedNonEmpty('dispatchId', args.dispatchId, PI_RPC_WORKER_ID_MAX_BYTES)
  assertBoundedNonEmpty('workerHandle', args.workerHandle, PI_RPC_WORKER_HANDLE_MAX_BYTES)
  assertBoundedNonEmpty('capability', args.capability, PI_RPC_WORKER_CAPABILITY_MAX_BYTES)
  assertBoundedString('taskSpec', args.taskSpec, PI_RPC_WORKER_TASK_SPEC_MAX_BYTES)
  assertPiRpcWorkerCliCommand(args.cliCommand)

  const serialized = JSON.stringify({
    protocol: PI_RPC_WORKER_DISPATCH_PROTOCOL,
    version: PI_RPC_WORKER_DISPATCH_VERSION,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    workerHandle: args.workerHandle,
    capability: args.capability,
    taskSpec: args.taskSpec,
    cliCommand: args.cliCommand
  } satisfies PiRpcWorkerDispatchEnvelope)
  if (utf8ByteLength(serialized) > PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES) {
    throw new Error('pi_rpc_worker_dispatch_envelope_too_large')
  }
  return serialized
}

/**
 * Parses the private supervisor input. sendTerminalAgentPrompt uses bracketed
 * paste, so accept that exact framing while rejecting every other prefix or
 * suffix instead of fishing JSON out of arbitrary terminal text.
 */
export function parsePiRpcWorkerDispatchEnvelope(input: string): PiRpcWorkerDispatchEnvelope {
  if (input.length > PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES) {
    throw new Error('pi_rpc_worker_dispatch_envelope_too_large')
  }
  const normalized = stripAgentPromptFraming(input)
  if (utf8ByteLength(normalized) > PI_RPC_WORKER_DISPATCH_ENVELOPE_MAX_BYTES) {
    throw new Error('pi_rpc_worker_dispatch_envelope_too_large')
  }

  let value: unknown
  try {
    value = JSON.parse(normalized)
  } catch {
    throw new Error('pi_rpc_worker_dispatch_envelope_invalid')
  }
  if (!isRecord(value) || Object.keys(value).length !== 8) {
    throw new Error('pi_rpc_worker_dispatch_envelope_invalid')
  }
  if (
    value.protocol !== PI_RPC_WORKER_DISPATCH_PROTOCOL ||
    value.version !== PI_RPC_WORKER_DISPATCH_VERSION
  ) {
    throw new Error('pi_rpc_worker_dispatch_protocol_unsupported')
  }
  assertBoundedNonEmpty('taskId', value.taskId, PI_RPC_WORKER_ID_MAX_BYTES)
  assertBoundedNonEmpty('dispatchId', value.dispatchId, PI_RPC_WORKER_ID_MAX_BYTES)
  assertBoundedNonEmpty('workerHandle', value.workerHandle, PI_RPC_WORKER_HANDLE_MAX_BYTES)
  assertBoundedNonEmpty('capability', value.capability, PI_RPC_WORKER_CAPABILITY_MAX_BYTES)
  assertBoundedString('taskSpec', value.taskSpec, PI_RPC_WORKER_TASK_SPEC_MAX_BYTES)
  assertPiRpcWorkerCliCommand(value.cliCommand)
  return value as PiRpcWorkerDispatchEnvelope
}

/**
 * Builds the prompt the supervisor may expose to Pi. Lifecycle authority stays
 * in supervisor-provided tools; no host routing or credential material is
 * interpolated here.
 */
export function buildPiRpcWorkerModelPrompt(taskSpec: string): string {
  assertBoundedString('taskSpec', taskSpec, PI_RPC_WORKER_TASK_SPEC_MAX_BYTES)
  return `You are a supervised coding worker. Complete only the task below.

Use only these supervisor-provided lifecycle tools for coordination:
- Call orca_report_progress for meaningful bounded progress updates; the supervisor sends heartbeats automatically.
- Call orca_ask_coordinator when you need a blocking coordinator decision.
- Call orca_escalate when work cannot continue without coordinator action.
- Call orca_worker_done exactly once with succeeded or failed, a three-sentence executive summary, and the files changed.
- After orca_worker_done succeeds, stop immediately; the supervisor will shut down this Pi process.

Do not search for, infer, request, print, or persist transport details or lifecycle credentials.

=== TASK ===
${taskSpec}`
}

function normalizeLaunchOption(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  assertBoundedNonEmpty(name, value, PI_RPC_WORKER_LAUNCH_OPTION_MAX_BYTES)
  if (value !== value.trim()) {
    throw new Error(`pi_rpc_worker_${name}_invalid`)
  }
  return value
}

function stripAgentPromptFraming(input: string): string {
  const withoutSubmit = input.endsWith('\r') ? input.slice(0, -1) : input
  if (!withoutSubmit.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)) {
    return withoutSubmit
  }
  if (!withoutSubmit.endsWith(AGENT_PROMPT_BRACKETED_PASTE_END)) {
    throw new Error('pi_rpc_worker_dispatch_envelope_invalid')
  }
  return withoutSubmit.slice(
    AGENT_PROMPT_BRACKETED_PASTE_START.length,
    -AGENT_PROMPT_BRACKETED_PASTE_END.length
  )
}

function assertPiRpcWorkerCliCommand(value: unknown): asserts value is PiRpcWorkerCliCommand {
  if (value !== 'orca' && value !== 'orca-ide' && value !== 'orca-dev') {
    throw new Error('pi_rpc_worker_cli_command_invalid')
  }
}

function assertBoundedNonEmpty(
  name: string,
  value: unknown,
  maxBytes: number
): asserts value is string {
  assertBoundedString(name, value, maxBytes)
  if (value.length === 0) {
    throw new Error(`pi_rpc_worker_${name}_invalid`)
  }
}

function assertBoundedString(
  name: string,
  value: unknown,
  maxBytes: number
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`pi_rpc_worker_${name}_invalid`)
  }
  if (value.length > maxBytes || utf8ByteLength(value) > maxBytes) {
    throw new Error(
      name === 'taskSpec'
        ? 'pi_rpc_worker_dispatch_envelope_too_large'
        : `pi_rpc_worker_${name}_invalid`
    )
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
