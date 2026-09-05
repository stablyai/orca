import type { Page } from '@stablyai/playwright-test'
import {
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeMessageContext
} from '../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../src/mobile-web/src/mobile-web-bridge-client'
import { parsePairingCode } from '../../src/shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../src/shared/remote-runtime-request-connection'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeWorktreePsResult
} from '../../src/shared/runtime-types'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import { MobileWebCapabilityBroker } from '../../mobile/src/mobile-web/mobile-web-capability-broker'
import { MOBILE_WEB_PRODUCTION_GRANTS } from '../../mobile/src/mobile-web/mobile-web-production-grants'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { reconnectDisconnectedDockerSshRelayTarget } from './helpers/docker-ssh-relay-reconnect'
import {
  DOCKER_SSH_NATIVE_CHAT_SESSION_ID,
  DOCKER_SSH_NATIVE_CHAT_TRANSCRIPT_PATH,
  publishDockerSshNativeChatSession,
  seedDockerSshNativeChatAgent,
  waitForDockerSshNativeChatAgentHook,
  writeDockerSshNativeChatTranscript
} from './helpers/docker-ssh-native-chat-fixture'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

test.describe('Docker SSH native-chat transcripts', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH transcript coverage uses POSIX tooling.')

  test('reads the remote transcript through raw and hosted bridge authority', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    let connection: RemoteRuntimeRequestConnection | null = null
    let hostedBridge: HostedMobileWebBridge | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      seedDockerSshNativeChatAgent(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      waitForDockerSshNativeChatAgentHook(target)
      writeDockerSshNativeChatTranscript(target, [
        { id: 'u-1', role: 'user', text: 'remote hello' }
      ])
      await publishDockerSshNativeChatSession(orcaPage, ptyId)
      connection = await connectRuntimeClient(orcaPage)
      const initialTab = await waitForTranscriptTab(orcaPage, connection, remote.worktreeId)

      await expect(
        readTranscript(connection, remote.worktreeId, initialTab.terminal, 40)
      ).resolves.toMatchObject({
        ok: true,
        result: {
          messages: [expect.objectContaining({ id: 'u-1' })]
        }
      })
      let lastWorktreeSnapshot = 'No worktree.ps response'
      try {
        await expect
          .poll(
            async () => {
              const response = await connection!.request<RuntimeWorktreePsResult>(
                'worktree.ps',
                undefined,
                10_000
              )
              if (!response.ok) {
                lastWorktreeSnapshot = `RPC error: ${JSON.stringify(response.error) ?? 'unknown'}`
                return false
              }
              lastWorktreeSnapshot = JSON.stringify(
                response.result.worktrees.map((worktree) => worktree.repo)
              )
              return response.result.worktrees.some((worktree) =>
                worktree.repo.includes('Docker SSH')
              )
            },
            { timeout: 15_000 }
          )
          .toBe(true)
      } catch (error) {
        throw new Error(`SSH workspace did not enter worktree.ps: ${lastWorktreeSnapshot}`, {
          cause: error
        })
      }
      hostedBridge = createHostedMobileWebBridge(connection)
      const hostedWorkspaceSnapshot = await hostedBridge.client.workspaceSnapshot({ limit: 100 })
      const hostedWorkspace = hostedWorkspaceSnapshot.workspaces.find(
        (workspace) =>
          workspace.repo.includes('Docker SSH') || workspace.name.includes('Docker SSH')
      )
      if (!hostedWorkspace) {
        throw new Error(
          `Hosted SSH bridge did not expose the sanitized remote workspace: ${JSON.stringify(
            hostedWorkspaceSnapshot.workspaces.map(({ name, repo, branch, isActive }) => ({
              name,
              repo,
              branch,
              isActive
            }))
          )}`
        )
      }
      expect(hostedWorkspace.repo).toContain('Docker SSH')
      const hostedSession = await hostedBridge.client.sessionSnapshot({
        workspaceId: hostedWorkspace.id
      })
      const hostedTab = hostedSession.tabs.find(
        (tab) => tab.type === 'terminal' && tab.nativeChatSessionId
      )
      expect(hostedTab).toBeDefined()
      if (hostedTab?.type !== 'terminal' || !hostedTab.nativeChatSessionId) {
        throw new Error('Hosted SSH session did not expose opaque native-chat authority')
      }
      await expect(
        hostedBridge.client.nativeChat.read({
          workspaceId: hostedWorkspace.id,
          sessionId: hostedTab.nativeChatSessionId,
          limit: 40
        })
      ).resolves.toMatchObject({
        messages: [expect.objectContaining({ id: 'u-1' })]
      })

      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await expect(
        readTranscript(connection, remote.worktreeId, initialTab.terminal, 40)
      ).resolves.toMatchObject({
        ok: true,
        result: { error: expect.any(String) }
      })
      await expect(
        hostedBridge.client.nativeChat.read({
          workspaceId: hostedWorkspace.id,
          sessionId: hostedTab.nativeChatSessionId,
          limit: 40
        })
      ).rejects.toMatchObject({ code: 'host_error' })

      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      writeDockerSshNativeChatTranscript(target, [
        { id: 'u-1', role: 'user', text: 'remote hello' },
        { id: 'a-1', role: 'assistant', text: 'remote recovered' }
      ])
      const reconnectedTab = await waitForTranscriptTab(orcaPage, connection, remote.worktreeId)
      await expect(
        readTranscript(connection, remote.worktreeId, reconnectedTab.terminal, 40)
      ).resolves.toMatchObject({
        ok: true,
        result: {
          messages: [expect.objectContaining({ id: 'u-1' }), expect.objectContaining({ id: 'a-1' })]
        }
      })
      const reconnectedHostedSession = await hostedBridge.client.sessionSnapshot({
        workspaceId: hostedWorkspace.id
      })
      const reconnectedHostedTab = reconnectedHostedSession.tabs.find(
        (tab) => tab.type === 'terminal' && tab.nativeChatSessionId
      )
      if (reconnectedHostedTab?.type !== 'terminal' || !reconnectedHostedTab.nativeChatSessionId) {
        throw new Error('Hosted SSH session did not reacquire opaque native-chat authority')
      }
      await expect(
        hostedBridge.client.nativeChat.read({
          workspaceId: hostedWorkspace.id,
          sessionId: reconnectedHostedTab.nativeChatSessionId,
          limit: 40
        })
      ).resolves.toMatchObject({
        messages: [expect.objectContaining({ id: 'u-1' }), expect.objectContaining({ id: 'a-1' })]
      })
    } finally {
      hostedBridge?.dispose()
      connection?.close()
      cleanupDockerSshRelayTarget(target)
    }
  })
})

async function connectRuntimeClient(page: Page): Promise<RemoteRuntimeRequestConnection> {
  const pairingUrl = await page.evaluate(async () => {
    const offer = await window.api.mobile.getRuntimePairingUrl({
      address: '127.0.0.1',
      rotate: true
    })
    if (!offer.available || !offer.pairingUrl) {
      throw new Error('Runtime pairing unavailable')
    }
    return offer.pairingUrl
  })
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('Invalid runtime pairing URL')
  }
  return new RemoteRuntimeRequestConnection(pairing)
}

async function waitForTranscriptTab(
  page: Page,
  connection: RemoteRuntimeRequestConnection,
  worktreeId: string
): Promise<{ terminal: string }> {
  let terminal: string | null = null
  let lastSnapshot = 'No session.tabs.list response'
  try {
    await expect
      .poll(
        async () => {
          const response = await connection.request<RuntimeMobileSessionTabsResult>(
            'session.tabs.list',
            { worktree: `id:${worktreeId}` },
            10_000
          )
          if (!response.ok) {
            lastSnapshot = `RPC error: ${JSON.stringify(response.error) ?? 'unknown'}`
            return null
          }
          lastSnapshot = JSON.stringify(
            response.result.tabs.map((candidate) => ({
              id: candidate.id,
              type: candidate.type,
              status: candidate.status,
              ...(candidate.type === 'terminal'
                ? {
                    terminal: candidate.terminal,
                    agentType: candidate.agentStatus?.agentType,
                    agentState: candidate.agentStatus?.state,
                    providerSessionId: candidate.agentStatus?.providerSession?.id
                  }
                : {})
            }))
          )
          const tab = response.result.tabs.find(
            (candidate) =>
              candidate.type === 'terminal' &&
              candidate.status === 'ready' &&
              candidate.agentStatus?.providerSession?.id === DOCKER_SSH_NATIVE_CHAT_SESSION_ID
          )
          terminal = tab?.type === 'terminal' && tab.status === 'ready' ? tab.terminal : null
          return terminal
        },
        { timeout: 30_000 }
      )
      .not.toBeNull()
  } catch (error) {
    const terminalContent = await getTerminalContent(page, 8_000)
    throw new Error(
      `Remote transcript session was not published.\nTabs: ${lastSnapshot}\nTerminal:\n${terminalContent}`,
      { cause: error }
    )
  }
  return { terminal: terminal! }
}

function readTranscript(
  connection: RemoteRuntimeRequestConnection,
  worktreeId: string,
  terminal: string,
  limit: number
) {
  return connection.request(
    'nativeChat.readSession',
    {
      agent: 'claude',
      sessionId: DOCKER_SSH_NATIVE_CHAT_SESSION_ID,
      transcriptPath: DOCKER_SSH_NATIVE_CHAT_TRANSCRIPT_PATH,
      worktreeId,
      terminal,
      limit
    },
    10_000
  )
}

type HostedMobileWebBridge = {
  client: MobileWebBridgeClient
  dispose: () => void
}

function createHostedMobileWebBridge(
  connection: RemoteRuntimeRequestConnection
): HostedMobileWebBridge {
  const context: MobileWebBridgeMessageContext = {
    shellSessionId: 'S'.repeat(43),
    buildId: 'a'.repeat(64)
  }
  const rpcClient = {
    sendRequest(method: string, params?: unknown, options?: { timeoutMs?: number }) {
      return connection.request(method, params, options?.timeoutMs ?? 10_000)
    }
  } as RpcClient
  let broker: MobileWebCapabilityBroker
  let requestIndex = 0
  const client = new MobileWebBridgeClient({
    context,
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
    createRequestId: () => String(requestIndex++).padStart(22, 'A'),
    postMessage(message) {
      const parsed = parseMobileWebBridgePageMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        return false
      }
      void broker.handle(parsed.value)
      return true
    }
  })
  broker = new MobileWebCapabilityBroker({
    context,
    getClient: () => rpcClient,
    isConnected: () => true,
    isActive: () => true,
    postMessage(message) {
      const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      client.receive(parsed.value)
    },
    nativeAuthority: {
      hapticFeedback() {},
      async clipboardAvailability() {
        return { hasText: false, hasImage: false }
      },
      async clipboardWrite() {
        return { confirmation: 'in-app' }
      },
      async openExternal() {},
      async terminalPreferences() {
        return {
          textScale: 1,
          autocompleteEnabled: true,
          linkOpenMode: 'orca-browser'
        }
      },
      async terminalTextScaleUpdate() {}
    },
    terminalClientId: 'ssh-hosted-e2e',
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length))
  })
  return {
    client,
    dispose() {
      client.dispose()
      broker.dispose()
    }
  }
}
