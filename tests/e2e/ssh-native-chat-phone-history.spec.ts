/**
 * A phone paired with the desktop shows the chat history of a Claude session running on an SSH host
 * (#26057): the transcript lives on the SSH host, so the desktop must read it there, not on itself.
 *
 * Run:
 *   ORCA_E2E_SSH_DOCKER=1 npx playwright test tests/e2e/ssh-native-chat-phone-history.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerRemote } from './ssh-codex-reconnect-replay-driver'
import { dockerExec, dockerWriteFile, shellQuote } from './ssh-codex-repro-remote-fixtures'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { decodePairingOffer, type PairingOffer } from '../../src/shared/pairing'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest
} from '../../src/shared/remote-runtime-client'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

type PhoneTab = {
  type: string
  agentStatus?: { providerSession?: { id: string; transcriptPath?: string } } | null
}

type ChatFrame = {
  type: string
  messages?: { blocks?: { type: string; text?: string }[] }[]
  pending?: boolean
  error?: string
}

function claudeTranscript(sessionId: string, prompt: string, reply: string): string {
  return `${[
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: '2026-10-07T03:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: prompt }
    },
    {
      sessionId,
      uuid: `${sessionId}-assistant`,
      timestamp: '2026-10-07T03:00:01.000Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: reply }]
      }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`
}

/** What a Claude hook on the execution host reports: its session id and transcript path. */
async function postClaudeHook(
  page: Page,
  ptyId: string,
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  const posted = `__ORCA_CLAUDE_HOOK_${Date.now()}__`
  const payload = {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    transcript_path: transcriptPath,
    prompt: 'hello'
  }
  // A background subshell, so the shell's command-finished marker does not clear the row.
  await execInTerminal(
    page,
    ptyId,
    [
      `hook_payload=${shellQuote(JSON.stringify(payload))}`,
      '(',
      '  sleep 0.1',
      '  if curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
      '    -H "Content-Type: application/x-www-form-urlencoded" \\',
      '    -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
      '    --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
      '    --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
      '    --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
      '    --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
      '    --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
      '    --data-urlencode "payload=${hook_payload}" >/dev/null; then',
      `    printf '%s%s\\n' ${shellQuote(posted.slice(0, 8))} ${shellQuote(posted.slice(8))}`,
      '  fi',
      ') &'
    ].join('\n')
  )
  await waitForTerminalOutput(page, posted, 20_000)
}

/** The provider session the phone's tab list carries for this worktree's agent tab. */
async function phoneProviderSession(
  pairing: PairingOffer,
  worktreeId: string,
  sessionId: string
): Promise<{ id: string; transcriptPath?: string }> {
  let found: { id: string; transcriptPath?: string } | undefined
  await expect
    .poll(
      async () => {
        const listed = await sendRemoteRuntimeRequest<{ tabs: PhoneTab[] }>(
          pairing,
          'session.tabs.list',
          { worktree: `id:${worktreeId}` },
          15_000
        )
        if (!listed.ok) {
          return JSON.stringify(listed)
        }
        found = listed.result.tabs
          .map((tab) => tab.agentStatus?.providerSession)
          .find((session) => session?.id === sessionId)
        return found ? 'listed' : 'no tab carries the provider session'
      },
      { timeout: 20_000 }
    )
    .toBe('listed')
  if (!found) {
    throw new Error('the phone tab list lost the provider session after listing it')
  }
  return found
}

/** Subscribe as the phone's chat view does; the caller reads frames and closes it. */
async function subscribePhoneChat(
  pairing: PairingOffer,
  session: { id: string; transcriptPath?: string }
): Promise<{ frames: ChatFrame[]; texts: () => string[]; close: () => void }> {
  const frames: ChatFrame[] = []
  const subscription = await subscribeRemoteRuntimeRequest<ChatFrame>(
    pairing,
    'nativeChat.subscribe',
    {
      agent: 'claude',
      sessionId: session.id,
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      subscriptionId: `e2e-phone-${Date.now()}`,
      capabilities: { transcriptPending: 1 }
    },
    30_000,
    {
      onResponse: (response) => {
        if (response.ok) {
          frames.push(response.result)
        }
      },
      onError: () => {}
    }
  )
  const texts = (): string[] =>
    frames.flatMap((frame) =>
      (frame.messages ?? []).flatMap((message) =>
        (message.blocks ?? []).flatMap((block) => (block.text ? [block.text] : []))
      )
    )
  return { frames, texts, close: () => subscription.close() }
}

async function expectPhoneText(
  chat: { frames: ChatFrame[]; texts: () => string[] },
  text: string
): Promise<void> {
  await expect
    .poll(() => chat.texts(), { timeout: 15_000, message: JSON.stringify(chat.frames) })
    .toContain(text)
}

test.describe('Phone chat history for an agent on the execution host (#26057)', () => {
  test('SSH workspace: the phone shows the Claude conversation stored on the SSH host', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
    test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX ssh tooling.')
    test.slow()
    const stamp = Date.now()
    const sessionId = `phone-ssh-${stamp}`
    const reply = `SSH_REPLY_${stamp}`
    const projectDir = `/root/.claude/projects/${DOCKER_SSH_RELAY_REMOTE_REPO_PATH.replaceAll('/', '-')}`
    const transcriptPath = `${projectDir}/${sessionId}.jsonl`
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      dockerExec(target, `mkdir -p ${shellQuote(projectDir)}`)
      dockerWriteFile(
        target,
        transcriptPath,
        claudeTranscript(sessionId, 'remote prompt', reply),
        '600'
      )

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemote(orcaPage, target)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
      await postClaudeHook(orcaPage, ptyId, sessionId, transcriptPath)

      const pairing = decodePairingOffer(
        (await createRuntimeDesktopPairingOffer(orcaPage)).pairingUrl
      )
      const session = await phoneProviderSession(pairing, remote.worktreeId, sessionId)
      expect(session.transcriptPath).toBe(transcriptPath)
      const chat = await subscribePhoneChat(pairing, session)
      try {
        await expectPhoneText(chat, reply)
        // A turn the agent writes on the SSH host afterwards reaches the open chat.
        const laterReply = `SSH_LATER_REPLY_${stamp}`
        dockerExec(
          target,
          `printf '%s\\n' ${shellQuote(
            JSON.stringify({
              sessionId,
              uuid: `${sessionId}-later`,
              timestamp: '2026-10-07T03:00:02.000Z',
              type: 'assistant',
              message: {
                role: 'assistant',
                model: 'claude-opus-4',
                content: [{ type: 'text', text: laterReply }]
              }
            })
          )} >> ${shellQuote(transcriptPath)}`
        )
        await expectPhoneText(chat, laterReply)
      } finally {
        chat.close()
      }
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
