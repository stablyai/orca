import type { Page } from '@stablyai/playwright-test'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  writeDockerSshRelayTargetFile,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'
import type { RemoteRuntimeRequestConnection } from '../../../src/shared/remote-runtime-request-connection'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'
import { execInTerminal, waitForTerminalOutput } from './terminal'

export const DOCKER_SSH_NATIVE_CHAT_TRANSCRIPT_PATH = '/tmp/orca-native-chat-ssh-e2e.jsonl'
export const DOCKER_SSH_NATIVE_CHAT_SESSION_ID = 'orca-native-chat-ssh-e2e'
const DOCKER_SSH_NATIVE_CHAT_PUBLISHER_PATH = '/tmp/orca-native-chat-ssh-e2e-publish.sh'
const DOCKER_SSH_NATIVE_CHAT_PUBLISHER_DIAGNOSTIC_PATH = '/tmp/orca-native-chat-ssh-e2e-publish.log'
const DOCKER_SSH_NATIVE_CHAT_CLAUDE_HOOK_PATH = '/root/.orca/agent-hooks/claude-hook.sh'

type DockerSshNativeChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/** Seed the smallest realistic Claude installation so SSH startup exercises Orca's remote hook installer. */
export function seedDockerSshNativeChatAgent(target: DockerSshRelayTarget): void {
  execDockerSshRelayTargetCommand(
    target,
    [
      'mkdir -p /root/.claude /usr/local/bin',
      "printf '%s\\n' '{}' > /root/.claude/settings.json",
      "printf '%s\\n' '#!/bin/sh' 'exit 0' > /usr/local/bin/claude",
      'chmod 755 /usr/local/bin/claude'
    ].join(' && ')
  )
}

export function waitForDockerSshNativeChatAgentHook(
  target: DockerSshRelayTarget,
  timeoutMs = 30_000
): void {
  const deadline = Date.now() + timeoutMs
  let lastDiagnostic = ''
  while (Date.now() < deadline) {
    try {
      execDockerSshRelayTargetCommand(target, `test -x ${DOCKER_SSH_NATIVE_CHAT_CLAUDE_HOOK_PATH}`)
      return
    } catch (error) {
      lastDiagnostic = error instanceof Error ? error.message : String(error)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  throw new Error(`Timed out waiting for remote Claude hook installation: ${lastDiagnostic}`)
}

export function writeDockerSshNativeChatTranscript(
  target: DockerSshRelayTarget,
  messages: readonly DockerSshNativeChatMessage[]
): void {
  writeDockerSshRelayTargetFile(
    target,
    DOCKER_SSH_NATIVE_CHAT_TRANSCRIPT_PATH,
    messages.map(claudeLine).join('')
  )
}

export function dockerSshNativeChatPublicationCommand(): string {
  return `sh ${DOCKER_SSH_NATIVE_CHAT_PUBLISHER_PATH}`
}

export function writeDockerSshNativeChatPublisher(target: DockerSshRelayTarget): void {
  writeDockerSshRelayTargetFile(
    target,
    DOCKER_SSH_NATIVE_CHAT_PUBLISHER_PATH,
    [
      '{',
      'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
      '  . "$ORCA_AGENT_HOOK_ENDPOINT"',
      'fi',
      "printf 'pane=%s tab=%s worktree=%s endpoint=%s port=%s token=%s script=%s\\n' \\",
      '  "$ORCA_PANE_KEY" \\',
      '  "$ORCA_TAB_ID" \\',
      '  "$ORCA_WORKTREE_ID" \\',
      '  "$([ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && printf 1 || printf 0)" \\',
      '  "$([ -n "$ORCA_AGENT_HOOK_PORT" ] && printf 1 || printf 0)" \\',
      '  "$([ -n "$ORCA_AGENT_HOOK_TOKEN" ] && printf 1 || printf 0)" \\',
      '  "$([ -r "$HOME/.orca/agent-hooks/claude-hook.sh" ] && printf 1 || printf 0)"',
      'sleep 0.5',
      `printf '%s' '${dockerSshNativeChatPayload()}' | base64 -d | sh "$HOME/.orca/agent-hooks/claude-hook.sh"`,
      'printf \'hook_exit=%s\\n\' "$?"',
      `} > ${DOCKER_SSH_NATIVE_CHAT_PUBLISHER_DIAGNOSTIC_PATH} 2>&1 &`,
      ''
    ].join('\n')
  )
}

export function readDockerSshNativeChatPublisherDiagnostic(target: DockerSshRelayTarget): string {
  return execDockerSshRelayTargetCommand(
    target,
    `test -f ${DOCKER_SSH_NATIVE_CHAT_PUBLISHER_DIAGNOSTIC_PATH} && cat ${DOCKER_SSH_NATIVE_CHAT_PUBLISHER_DIAGNOSTIC_PATH} || true`
  )
}

export async function publishDockerSshNativeChatSession(page: Page, ptyId: string): Promise<void> {
  const payload = dockerSshNativeChatPayload()
  const marker = `NATIVE_CHAT_HOOK_${Date.now()}`
  await execInTerminal(
    page,
    ptyId,
    [
      "printf 'NATIVE_CHAT_HOOK_DIAG pane=%s tab=%s worktree=%s endpoint=%s script=%s\\n' \\",
      '  "$([ -n "$ORCA_PANE_KEY" ] && printf 1 || printf 0)" \\',
      '  "$([ -n "$ORCA_TAB_ID" ] && printf 1 || printf 0)" \\',
      '  "$([ -n "$ORCA_WORKTREE_ID" ] && printf 1 || printf 0)" \\',
      '  "$([ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && printf 1 || printf 0)" \\',
      '  "$([ -r "$HOME/.orca/agent-hooks/claude-hook.sh" ] && printf 1 || printf 0)"',
      '(',
      '  sleep 0.1',
      `  printf '%s' '${payload}' | base64 -d | sh "$HOME/.orca/agent-hooks/claude-hook.sh"`,
      `  echo ${marker}`,
      ') &'
    ].join('\n')
  )
  await waitForTerminalOutput(page, marker, 30_000, 80_000)
}

export async function waitForDockerSshNativeChatPublication(
  page: Page,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = 'No agent statuses'
  let lastMainSnapshot = 'No main-process agent statuses'
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(async (sessionId) => {
      const statuses = Object.values(window.__store?.getState().agentStatusByPaneKey ?? {})
      const mainStatuses = await window.api.agentStatus.getSnapshot()
      return {
        published: statuses.some((status) => status?.providerSession?.id === sessionId),
        mainStatuses,
        statuses: statuses.map((status) => ({
          agentType: status?.agentType,
          providerSessionId: status?.providerSession?.id,
          state: status?.state
        }))
      }
    }, DOCKER_SSH_NATIVE_CHAT_SESSION_ID)
    lastSnapshot = JSON.stringify(snapshot.statuses)
    lastMainSnapshot = JSON.stringify(snapshot.mainStatuses)
    if (snapshot.published) {
      return
    }
    await delay(250)
  }
  throw new Error(
    `Docker SSH native-chat publication timed out. Renderer: ${lastSnapshot}; main: ${lastMainSnapshot}`
  )
}

export async function waitForDockerSshNativeChatRuntimePublication(
  connection: RemoteRuntimeRequestConnection,
  worktreeId: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = 'No session.tabs.list response'
  while (Date.now() < deadline) {
    const response = await connection.request<RuntimeMobileSessionTabsResult>(
      'session.tabs.list',
      { worktree: `id:${worktreeId}` },
      10_000
    )
    if (!response.ok) {
      lastSnapshot = `RPC error: ${JSON.stringify(response.error) ?? 'unknown'}`
    } else {
      const tabs = response.result.tabs.map((tab) => ({
        id: tab.id,
        type: tab.type,
        ...(tab.type === 'terminal'
          ? {
              status: tab.status,
              launchAgent: tab.launchAgent,
              agentType: tab.agentStatus?.agentType,
              providerSessionId: tab.agentStatus?.providerSession?.id
            }
          : {})
      }))
      lastSnapshot = JSON.stringify(tabs)
      if (
        response.result.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            tab.status === 'ready' &&
            tab.agentStatus?.providerSession?.id === DOCKER_SSH_NATIVE_CHAT_SESSION_ID
        )
      ) {
        return
      }
    }
    await delay(250)
  }
  throw new Error(
    `Docker SSH runtime native-chat publication timed out. Last tabs: ${lastSnapshot}`
  )
}

function dockerSshNativeChatPayload(): string {
  return Buffer.from(
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: DOCKER_SSH_NATIVE_CHAT_SESSION_ID,
      transcript_path: DOCKER_SSH_NATIVE_CHAT_TRANSCRIPT_PATH,
      prompt: 'remote transcript test',
      cwd: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
    })
  ).toString('base64')
}

function claudeLine(message: DockerSshNativeChatMessage): string {
  const { id, role, text } = message
  return `${JSON.stringify({
    type: role,
    uuid: id,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
