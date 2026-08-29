import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  REPO_ROOT,
  type ReleaseCheckout
} from './release-checkout'

/**
 * The two things that decide whether a structured agent session exists for a given
 * pairing: the capability strings a build can name, and the RPC methods it
 * registers. Both are read per build, so "the old side does not have it" is a fact
 * about a real release rather than a hand-written list.
 */

export const WORKING_TREE = 'working-tree' as const

export type RpcReply = {
  id: string
  ok: boolean
  streaming?: true
  result?: unknown
  error?: { code: string; message: string }
}

export type RpcClientIdentity = {
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly string[]
  connectionId?: string
  clientId?: string
}

export type AgentSessionDispatcher = {
  dispatchStreaming: (
    request: { id: string; authToken: string; method: string; params?: unknown },
    reply: (message: string) => void,
    options?: RpcClientIdentity
  ) => Promise<void>
}

export type AgentSessionWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  /** Capability strings this build defines. A peer cannot advertise — nor a client
   *  ask for — a string its own source never names. */
  capabilities: readonly string[]
  protocolVersion: number
  /** RPC method names the build registers, read from source. */
  methodNames: readonly string[]
  /** A dispatcher carrying a method set this build really ships, so an
   *  unknown-method answer is about the method and not an empty registry. */
  createDispatcher: (runtime: unknown) => AgentSessionDispatcher
}

type DispatcherModule = {
  RpcDispatcher: new (options: { runtime: unknown; methods: unknown[] }) => AgentSessionDispatcher
}

// A dotted literal in a `name:` position. Deliberately loose: over-matching only
// makes "this build registers no agentSession method" a stronger claim.
const METHOD_NAME = /\bname:\s*'([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)'/g

/**
 * Method names declared under `runtime/rpc/methods`, scanned rather than imported:
 * a released build's method manifest reaches Electron, which cannot load here.
 */
function scanMethodNames(root: string): string[] {
  const names = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        for (const match of readFileSync(full, 'utf8').matchAll(METHOD_NAME)) {
          names.add(match[1]!)
        }
      }
    }
  }
  walk(join(root, 'src', 'main', 'runtime', 'rpc', 'methods'))
  return [...names].sort()
}

function capabilityStrings(module: Record<string, unknown>): readonly string[] {
  const declared = module.RUNTIME_CAPABILITIES
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('Cross-version harness found no RUNTIME_CAPABILITIES to compare')
  }
  return declared as readonly string[]
}

async function loadWorkingTreeBuild(): Promise<AgentSessionWireBuild> {
  const [protocol, dispatcher, structured, aiVault, sessionTabs, terminal] = await Promise.all([
    import('../../../src/shared/protocol-version'),
    import('../../../src/main/runtime/rpc/dispatcher'),
    import('../../../src/main/runtime/rpc/methods/structured-agent-session'),
    import('../../../src/main/runtime/rpc/methods/ai-vault'),
    import('../../../src/main/runtime/rpc/methods/session-tabs'),
    import('../../../src/main/runtime/rpc/methods/terminal')
  ])
  const module = dispatcher as unknown as DispatcherModule
  return {
    label: WORKING_TREE,
    revision: WORKING_TREE,
    capabilities: capabilityStrings(protocol as unknown as Record<string, unknown>),
    protocolVersion: protocol.RUNTIME_PROTOCOL_VERSION,
    methodNames: scanMethodNames(REPO_ROOT),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods: [
          ...(structured.STRUCTURED_AGENT_SESSION_METHODS as unknown[]),
          ...(aiVault.AI_VAULT_METHODS as unknown[]),
          ...(sessionTabs.SESSION_TAB_METHODS as unknown[]),
          ...(terminal.TERMINAL_METHODS as unknown[])
        ]
      })
  }
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<AgentSessionWireBuild> {
  const [protocol, dispatcher, terminalMethods] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/methods/terminal.ts')
  ])
  const module = dispatcher as unknown as DispatcherModule
  return {
    label: checkout.ref,
    revision: checkout.commit,
    capabilities: capabilityStrings(protocol),
    protocolVersion: protocol.RUNTIME_PROTOCOL_VERSION as number,
    methodNames: scanMethodNames(checkout.root),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods: terminalMethods.TERMINAL_METHODS as unknown[]
      })
  }
}

/**
 * Load the structured-session wire surface for one build. `WORKING_TREE` imports
 * current source; any other value is a git ref extracted into a cached checkout.
 */
export async function loadAgentSessionWireBuild(ref: string): Promise<AgentSessionWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(await materializeReleaseCheckout(ref))
}
