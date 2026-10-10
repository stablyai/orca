/**
 * Who decides where an operation runs.
 * - `host`: the host that owns the resource (a workspace, terminal, session or account).
 * - `credential`: forge APIs. A runtime-owned repo goes to its owner runtime; a local or SSH repo
 *   uses this desktop's credentials. Never chosen by focus.
 * - `client`: an effect on this client (reveal, open in editor); never sent to a host.
 * - `stream`: a subscription that lives on the host owning the subscribed resource.
 * - `scope-picked`: row-less work whose host comes from an explicit picker, never from focus.
 */
export type HostOperationOwnership = 'host' | 'credential' | 'client' | 'stream' | 'scope-picked'

/** By runtime RPC namespace; client effects by their preload API name. */
export const HOST_OPERATION_OWNERSHIP = {
  accounts: 'host',
  agent: 'host',
  agentHooks: 'host',
  agentSession: 'host',
  agentSessionAttachment: 'host',
  agentTeams: 'host',
  aiVault: 'host',
  artifacts: 'host',
  automation: 'host',
  browser: 'host',
  clipboard: 'host',
  computer: 'host',
  diagnostics: 'host',
  emulator: 'host',
  files: 'host',
  folderWorkspace: 'host',
  git: 'host',
  github: 'credential',
  gitlab: 'credential',
  host: 'host',
  hostedReview: 'credential',
  jira: 'scope-picked',
  layout: 'host',
  linear: 'scope-picked',
  managedServer: 'host',
  markdown: 'host',
  mobileWeb: 'host',
  nativeChat: 'host',
  network: 'host',
  notifications: 'host',
  orcad: 'host',
  orchestration: 'host',
  pairing: 'host',
  plugins: 'host',
  preflight: 'host',
  project: 'host',
  projectGroup: 'host',
  projectHostSetup: 'host',
  reference: 'host',
  repo: 'host',
  runtime: 'host',
  session: 'host',
  settings: 'scope-picked',
  shell: 'client',
  skills: 'host',
  speech: 'host',
  ssh: 'host',
  stats: 'host',
  status: 'host',
  terminal: 'host',
  ui: 'host',
  updater: 'host',
  workspacePorts: 'host',
  worktree: 'host'
} as const satisfies Record<string, HostOperationOwnership>

const OWNERSHIP_BY_NAMESPACE: ReadonlyMap<string, HostOperationOwnership> = new Map(
  Object.entries(HOST_OPERATION_OWNERSHIP)
)
const STREAM_METHOD = /^(un)?(subscribe|watch)/i

/** Null for a namespace nobody classified, so callers fail closed. */
export function getHostOperationOwnership(method: string): HostOperationOwnership | null {
  const ownership = OWNERSHIP_BY_NAMESPACE.get(method.slice(0, method.indexOf('.')))
  if (!ownership || !method.includes('.')) {
    return null
  }
  const leaf = method.slice(method.lastIndexOf('.') + 1)
  return ownership !== 'client' && STREAM_METHOD.test(leaf) ? 'stream' : ownership
}
