import type { ElectronApplication } from '@stablyai/playwright-test'

type ProofRequest = {
  selector?: string
  method?: string
  sourceChat?: { workspaceId?: string }
  params?: { tabId?: string; leafId?: string }
  expectedEnvironmentPairingRevision?: number
}

declare global {
  var rowMenuProofCalls: { channel: string; args: ProofRequest }[] | undefined
}

export async function captureProofCalls(
  electronApp: ElectronApplication,
  config: { workspaceId: string; repoPath: string; forkSessionId: string; environmentId: string }
) {
  await electronApp.evaluate(({ ipcMain }, config) => {
    type Handler = (event: unknown, args: ProofRequest) => unknown
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('Electron IPC fixture cannot locate invoke handlers')
    }
    const handlers: Map<string, Handler> = ipcMain._invokeHandlers
    const calls: NonNullable<typeof globalThis.rowMenuProofCalls> = []
    globalThis.rowMenuProofCalls = calls
    const localPrepare = handlers.get('aiVault:prepareSessionResume')!
    handlers.set('aiVault:prepareSessionResume', (event, args) => {
      if (args.sourceChat?.workspaceId !== config.workspaceId) {
        return localPrepare(event, args)
      }
      calls.push({ channel: 'local prepare', args })
      return {
        cliForkSource: {
          agent: 'codex',
          sourceAgent: 'codex',
          sessionId: config.forkSessionId,
          filePath: `${config.repoPath}/fixture-transcript.jsonl`,
          cwd: config.repoPath,
          codexHome: null,
          executionHostPlatform: process.platform
        },
        forkedSession: { agent: 'codex', sessionId: config.forkSessionId }
      }
    })
    const pairedCall = handlers.get('runtimeEnvironments:call')!
    handlers.set('runtimeEnvironments:call', (event, args) => {
      if (args.selector !== config.environmentId) {
        return pairedCall(event, args)
      }
      calls.push({ channel: 'paired call', args })
      const results: Record<string, unknown> = {
        'status.get': { runtimeId: 'proof-paired-runtime', capabilities: [] },
        'session.tabs.list': { tabs: [] },
        'session.tabs.activate': { activated: true },
        'worktree.activate': { activated: true }
      }
      const result = results[args.method ?? ''] ?? {}
      return { id: 'fixture', ok: true, result, _meta: { runtimeId: 'proof-paired-runtime' } }
    })
  }, config)
  const calls = () =>
    electronApp.evaluate(() => {
      if (!globalThis.rowMenuProofCalls) {
        throw new Error('Electron IPC fixture did not initialize call capture')
      }
      return globalThis.rowMenuProofCalls
    })
  const preparations = async () =>
    (await calls()).filter(
      (call) =>
        call.channel === 'local prepare' || call.args.method === 'aiVault.prepareSessionResume'
    ).length
  return { calls, preparations }
}
