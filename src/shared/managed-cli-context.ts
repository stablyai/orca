import { MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY } from './protocol-version'

export const MANAGED_CLI_CONTEXT_FIELD_MAX_LENGTH = 4096

export const MANAGED_CLI_CONTEXT_ENV = {
  executable: 'ORCA_MANAGED_CLI_EXECUTABLE',
  runtimeId: 'ORCA_MANAGED_CLI_RUNTIME_ID',
  executionHostId: 'ORCA_MANAGED_CLI_EXECUTION_HOST_ID',
  workspaceKey: 'ORCA_MANAGED_CLI_WORKSPACE_KEY',
  terminalHandle: 'ORCA_MANAGED_CLI_TERMINAL_HANDLE',
  protocolCapability: 'ORCA_MANAGED_CLI_PROTOCOL_CAPABILITY'
} as const

export type ManagedCliContext = {
  executable: string
  runtimeId: string
  executionHostId: string
  workspaceKey: string
  terminalHandle: string
  protocolCapability: typeof MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY
}

export type ManagedCliContextInput = Omit<ManagedCliContext, 'protocolCapability'> & {
  protocolCapability?: typeof MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY
}

export function createManagedCliContext(input: ManagedCliContextInput): ManagedCliContext {
  const fields = [
    ['executable', input.executable],
    ['runtimeId', input.runtimeId],
    ['executionHostId', input.executionHostId],
    ['workspaceKey', input.workspaceKey],
    ['terminalHandle', input.terminalHandle]
  ] as const
  for (const [name, value] of fields) {
    if (value.trim().length === 0) {
      throw new Error(`managed_cli_context_${name}_required`)
    }
    // Why: these values cross an env-var boundary into a spawned process and
    // are rendered verbatim into a preamble a worker reads as plain text —
    // a control character (embedded newline, NUL) could inject a fake
    // preamble line or corrupt the env encoding. Ordinary spaces (as in a
    // Windows "C:\Program Files\..." path) are fine; env vars are never
    // shell-parsed, so no quoting/escaping is needed or applied here.
    if (/\p{Cc}/u.test(value)) {
      throw new Error(`managed_cli_context_${name}_invalid`)
    }
    if (value.length > MANAGED_CLI_CONTEXT_FIELD_MAX_LENGTH) {
      throw new Error(`managed_cli_context_${name}_too_long`)
    }
  }
  if (
    input.protocolCapability !== undefined &&
    input.protocolCapability !== MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY
  ) {
    throw new Error('managed_cli_context_capability_invalid')
  }
  return {
    executable: input.executable,
    runtimeId: input.runtimeId,
    executionHostId: input.executionHostId,
    workspaceKey: input.workspaceKey,
    terminalHandle: input.terminalHandle,
    protocolCapability: MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY
  }
}

export function managedCliContextToEnv(context: ManagedCliContext): Record<string, string> {
  return {
    [MANAGED_CLI_CONTEXT_ENV.executable]: context.executable,
    [MANAGED_CLI_CONTEXT_ENV.runtimeId]: context.runtimeId,
    [MANAGED_CLI_CONTEXT_ENV.executionHostId]: context.executionHostId,
    [MANAGED_CLI_CONTEXT_ENV.workspaceKey]: context.workspaceKey,
    [MANAGED_CLI_CONTEXT_ENV.terminalHandle]: context.terminalHandle,
    [MANAGED_CLI_CONTEXT_ENV.protocolCapability]: context.protocolCapability
  }
}

export function managedCliContextFromEnv(
  env: Record<string, string | undefined>
): ManagedCliContext | null {
  const values = {
    executable: env[MANAGED_CLI_CONTEXT_ENV.executable],
    runtimeId: env[MANAGED_CLI_CONTEXT_ENV.runtimeId],
    executionHostId: env[MANAGED_CLI_CONTEXT_ENV.executionHostId],
    workspaceKey: env[MANAGED_CLI_CONTEXT_ENV.workspaceKey],
    terminalHandle: env[MANAGED_CLI_CONTEXT_ENV.terminalHandle],
    protocolCapability: env[MANAGED_CLI_CONTEXT_ENV.protocolCapability]
  }
  if (Object.values(values).every((value) => value === undefined)) {
    return null
  }
  const {
    executable,
    runtimeId,
    executionHostId,
    workspaceKey,
    terminalHandle,
    protocolCapability
  } = values
  if (
    typeof executable !== 'string' ||
    executable.trim().length === 0 ||
    typeof runtimeId !== 'string' ||
    runtimeId.trim().length === 0 ||
    typeof executionHostId !== 'string' ||
    executionHostId.trim().length === 0 ||
    typeof workspaceKey !== 'string' ||
    workspaceKey.trim().length === 0 ||
    typeof terminalHandle !== 'string' ||
    terminalHandle.trim().length === 0 ||
    typeof protocolCapability !== 'string' ||
    protocolCapability.trim().length === 0
  ) {
    return null
  }
  if (protocolCapability !== MANAGED_CLI_CONTEXT_RUNTIME_CAPABILITY) {
    return null
  }
  return createManagedCliContext({
    executable,
    runtimeId,
    executionHostId,
    workspaceKey,
    terminalHandle,
    protocolCapability
  })
}

/**
 * Thrown when a managed worker would be created on an SSH execution host whose
 * remote `orca` launcher shim never installed. Never degrade to bare `orca`
 * PATH resolution in this case — the shim that bare `orca` depends on is
 * exactly what failed to install.
 */
export class ManagedCliLauncherUnavailableError extends Error {
  readonly code = 'managed_cli_launcher_unavailable' as const

  constructor(
    readonly executionHostId: string,
    readonly reason: string
  ) {
    super(`Managed CLI launcher unavailable for execution host ${executionHostId}: ${reason}`)
    this.name = 'ManagedCliLauncherUnavailableError'
  }
}

export function resolveManagedCliExecutable(args: {
  platform: NodeJS.Platform
  isPackaged: boolean
  launcherPath?: string | null
  devCommand?: string
}): string {
  if (args.launcherPath?.trim()) {
    return args.launcherPath
  }
  if (!args.isPackaged && args.devCommand?.trim()) {
    return args.devCommand
  }
  if (args.platform === 'linux') {
    return 'orca-ide'
  }
  return 'orca'
}
