import { vi } from 'vitest'
import { importBuildModule, type TerminalWireBuild } from './versioned-terminal-wire'

/**
 * The half of the reattach-failure contract the publication skew harness cannot see.
 *
 * `reattach-failure-publication-skew.ts` proves what each CLIENT build DOES with a
 * published token, but it answers `terminal.recoverPane` from a mock that always
 * grants a replacement handle. The client's request is not the mutation — the
 * HOST's grant is. And the host decides that from durable state it wrote itself,
 * long before any client version is in the picture:
 *
 *   relay: sourceRecovery=restoreRequired (the shell is still running)
 *     -> SshPtyProvider publishes a failure token
 *     -> ipc/pty.ts marks the SSH lease `expired` iff that token reads as expiry
 *     -> OrcaRuntimeService.recoverTerminalPane creates a replacement shell iff a
 *        recent expired lease exists for the pane.
 *
 * So the duplicate-agent bug is host-authorized, not client-authorized, and it is
 * reachable from ANY client version. This harness runs all three of those
 * production decisions for one build and reports what the host actually did.
 */

const CONNECTION_ID = 'ssh-1'
const RELAY_SESSION_ID = 'pty-live-shell'
const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/tmp/orca-skew-worktree'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-skew'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const REPLACEMENT_HANDLE = 'term-replacement'
const APP_PTY_ID = `ssh:${CONNECTION_ID}@@${RELAY_SESSION_ID}`

type SshLease = {
  targetId: string
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  state: string
  createdAt: number
  updatedAt: number
}

type LeaseLedger = {
  leases: SshLease[]
  writes: { ptyId: string; state: string }[]
  markSshRemotePtyLease: (targetId: string, ptyId: string, state: string) => void
  upsertSshRemotePtyLease: (lease: Record<string, unknown>) => void
  removeSshRemotePtyLease: (targetId: string, ptyId: string) => void
  getSshRemotePtyLeases: () => SshLease[]
  persistPtyBinding: (binding: Record<string, unknown>) => void
  removePtyBinding: (ptyId: string) => void
  getPtyBindings: () => Record<string, unknown>[]
}

/**
 * Stands in for the sqlite lease table only. Every decision about WHAT to write
 * and HOW to read it stays in production code on both ends.
 */
function createLeaseLedger(): LeaseLedger {
  const now = Date.now()
  const leases: SshLease[] = [
    {
      targetId: CONNECTION_ID,
      ptyId: RELAY_SESSION_ID,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      state: 'attached',
      createdAt: now,
      updatedAt: now
    }
  ]
  const writes: { ptyId: string; state: string }[] = []
  return {
    leases,
    writes,
    markSshRemotePtyLease: (targetId, ptyId, state) => {
      writes.push({ ptyId, state })
      const lease = leases.find((entry) => entry.targetId === targetId && entry.ptyId === ptyId)
      if (lease) {
        lease.state = state
        lease.updatedAt = Date.now()
      }
    },
    upsertSshRemotePtyLease: () => {},
    removeSshRemotePtyLease: () => {},
    getSshRemotePtyLeases: () => leases,
    persistPtyBinding: () => {},
    removePtyBinding: () => {},
    getPtyBindings: () => []
  }
}

// The repo/settings surface OrcaRuntimeService reads while resolving a pane.
const RUNTIME_STORE_BASE = {
  getRepo: (id: string) => RUNTIME_STORE_BASE.getRepos().find((repo) => repo.id === id),
  getRepos: () => [
    { id: REPO_ID, path: WORKTREE_PATH, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
  ],
  getAllWorktreeMeta: () => ({
    [WORKTREE_ID]: {
      displayName: 'skew',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) => RUNTIME_STORE_BASE.getAllWorktreeMeta()[worktreeId],
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  }),
  getProjects: () => [],
  getSparsePresets: () => []
}

type PtyIpcModule = {
  registerPtyHandlers: (...args: unknown[]) => void
  registerSshPtyProvider: (connectionId: string, provider: unknown) => void
  unregisterSshPtyProvider: (connectionId: string) => void
}

type SshProviderModule = {
  SshPtyProvider: new (connectionId: string, mux: unknown) => unknown
}

type RuntimeModule = {
  OrcaRuntimeService: new (store: unknown) => {
    registerPty: (
      ptyId: string,
      worktreeId: string,
      connectionId: string | null,
      identity: { tabId: string; leafId: string }
    ) => void
    resolveTerminalPane: (paneKey: string, worktreeId: string) => { handle: string }
    onPtyExit: (ptyId: string, code: number) => void
    createTerminal: (...args: unknown[]) => Promise<unknown>
  }
}

export type HostRecoveryAuthorizationOutcome = {
  hostLabel: string
  /** Which id space the pane's PTY was registered under for this drive. */
  runtimePtyIdSpace: 'relay' | 'app'
  /** The token this build's real SshPtyProvider threw for a live-shell source loss. */
  publishedFailure: string
  /** Lease-state writes this build's real ipc/pty.ts made while failing the reattach. */
  leaseWrites: { ptyId: string; state: string }[]
  /** The pane's lease state after the failed reattach, as the host would persist it. */
  leaseStateAfterFailure: string
  /** How the host's real `terminal.recoverPane` answered the client's request. */
  recoverPaneOutcome: 'granted' | 'refused'
  recoverPaneError: string | null
  /** Replacement shells the host actually created. The mutation, counted. */
  replacementShellsCreated: number
  /** The pane was genuinely attached before the fault, so the drive is not vacuous. */
  attachedBeforeFault: boolean
}

/**
 * Run one host build end to end: real SSH provider, real `pty:spawn` handler, real
 * runtime recovery gate, real RPC dispatcher. Nothing here names a token, so the
 * oracle tracks production rather than restating it.
 */
export async function driveHostRecoveryAuthorization(args: {
  hostBuild: TerminalWireBuild
  /**
   * Which id the pane's PTY is registered under in the runtime graph.
   *
   * `ipc/pty.ts` writes the lease with the RELAY id but calls `runtime.registerPty`
   * with the APP id (`ssh:<conn>@@<relay>`), and the recovery gate compares the two
   * directly. `relay` is the space where a legacy grant is reachable at all; `app`
   * is the shape production registers. Both are driven so a refusal cannot be
   * mistaken for an id that simply never matched.
   */
  runtimePtyIdSpace: 'relay' | 'app'
}): Promise<HostRecoveryAuthorizationOutcome> {
  const { hostBuild } = args
  const runtimePtyId = args.runtimePtyIdSpace === 'app' ? APP_PTY_ID : RELAY_SESSION_ID
  const [ptyIpc, providerModule, runtimeModule] = (await Promise.all([
    importBuildModule(hostBuild.label, 'main/ipc/pty.ts'),
    importBuildModule(hostBuild.label, 'main/providers/ssh-pty-provider.ts'),
    importBuildModule(hostBuild.label, 'main/runtime/orca-runtime.ts')
  ])) as unknown as [PtyIpcModule, SshProviderModule, RuntimeModule]

  const ledger = createLeaseLedger()
  let attachAnswer: Record<string, unknown> = { incarnationId: 'incarnation-attached' }
  const mux = {
    request: vi.fn(async (method: string) => (method === 'pty.attach' ? attachAnswer : {})),
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn())
  }
  const provider = new providerModule.SshPtyProvider(CONNECTION_ID, mux)

  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  const { ipcMain } = (await import('electron')) as unknown as {
    ipcMain: { handle: { mockImplementation: (fn: unknown) => void } }
  }
  ipcMain.handle.mockImplementation(
    (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  )

  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      isDestroyed: () => false
    }
  }

  ptyIpc.registerSshPtyProvider(CONNECTION_ID, provider)
  try {
    ptyIpc.registerPtyHandlers(mainWindow, undefined, undefined, undefined, undefined, ledger)
    const spawn = handlers.get('pty:spawn')
    if (!spawn) {
      throw new Error(`${hostBuild.label}: pty:spawn handler was never registered`)
    }
    const spawnArgs = {
      cols: 80,
      rows: 24,
      env: {},
      connectionId: CONNECTION_ID,
      sessionId: RELAY_SESSION_ID,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID
    }

    // The pane is genuinely attached first: a refusal below must mean the host
    // withheld a replacement, not that nothing ever connected.
    const attached = await spawn(null, spawnArgs)
    const attachedBeforeFault =
      typeof (attached as { id?: unknown })?.id === 'string' &&
      ledger.leases[0]?.state === 'attached'

    // The relay now answers the reattach the way it does for a live shell whose
    // output source must be re-established.
    attachAnswer = {
      incarnationId: 'incarnation-reattached',
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
    }
    let publishedFailure = ''
    try {
      await spawn(null, spawnArgs)
    } catch (error) {
      publishedFailure = error instanceof Error ? error.message : String(error)
    }
    if (!publishedFailure) {
      throw new Error(
        `${hostBuild.label}: reattach with sourceRecovery=restoreRequired resolved instead of failing closed`
      )
    }

    // The client asks the host to replace the pane's shell. Whether that request
    // is granted is the host's decision, and it reads the lease written above.
    const runtime = new runtimeModule.OrcaRuntimeService({
      ...RUNTIME_STORE_BASE,
      getSshRemotePtyLeases: ledger.getSshRemotePtyLeases
    })
    runtime.registerPty(runtimePtyId, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const paneHandle = runtime.resolveTerminalPane(PANE_KEY, WORKTREE_ID).handle
    runtime.onPtyExit(runtimePtyId, -1)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: REPLACEMENT_HANDLE,
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      ptyId: 'pty-replacement',
      worktreeId: WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    const dispatcher = new hostBuild.host.RpcDispatcher({
      runtime,
      methods: hostBuild.host.TERMINAL_METHODS
    }) as unknown as {
      dispatch: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    const response = await dispatcher.dispatch({
      id: 'recover-1',
      authToken: 'cross-version-token',
      method: 'terminal.recoverPane',
      params: { paneKey: PANE_KEY, worktreeId: WORKTREE_ID, expectedTerminal: paneHandle }
    })
    const granted = response.ok === true
    const error = response.error as { message?: string } | undefined

    return {
      hostLabel: hostBuild.label,
      runtimePtyIdSpace: args.runtimePtyIdSpace,
      publishedFailure,
      leaseWrites: ledger.writes,
      leaseStateAfterFailure: ledger.leases[0]?.state ?? 'missing',
      recoverPaneOutcome: granted ? 'granted' : 'refused',
      recoverPaneError: granted ? null : (error?.message ?? String(response.error ?? 'unknown')),
      replacementShellsCreated: createTerminal.mock.calls.length,
      attachedBeforeFault
    }
  } finally {
    ptyIpc.unregisterSshPtyProvider(CONNECTION_ID)
    vi.restoreAllMocks()
  }
}

export const SKEW_HOST_PANE = {
  paneKey: PANE_KEY,
  worktreeId: WORKTREE_ID,
  relaySessionId: RELAY_SESSION_ID,
  connectionId: CONNECTION_ID,
  replacementHandle: REPLACEMENT_HANDLE
}
