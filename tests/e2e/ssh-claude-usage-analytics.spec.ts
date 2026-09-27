import type { TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerRemote } from './ssh-codex-reconnect-replay-driver'
import { dockerExec, dockerWriteFile } from './ssh-codex-repro-remote-fixtures'
import { getStoreState, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

function claudeTranscript(sessionId: string, cwd: string, inputTokens: number): string {
  const timestamp = new Date(Date.now() - 60 * 60_000).toISOString()
  return `${JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    cwd,
    message: {
      id: `msg-${sessionId}`,
      model: 'claude-opus-5',
      usage: { input_tokens: inputTokens, output_tokens: 7 }
    }
  })}\n`
}

function seedRemoteClaudeUsage(target: DockerSshRelayTarget, stamp: number): void {
  dockerExec(target, 'mkdir -p /root/.claude/projects/orca /root/.claude/projects/scratch')
  dockerWriteFile(
    target,
    `/root/.claude/projects/orca/remote-usage-${stamp}.jsonl`,
    claudeTranscript(`remote-usage-${stamp}`, DOCKER_SSH_RELAY_REMOTE_REPO_PATH, 4321),
    '600'
  )
  dockerWriteFile(
    target,
    `/root/.claude/projects/scratch/remote-outside-${stamp}.jsonl`,
    claudeTranscript(`remote-outside-${stamp}`, '/tmp/not-an-orca-worktree', 1000),
    '600'
  )
}

test.describe('SSH Claude usage analytics', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX ssh tooling.')

  test('counts Claude transcripts that live on the SSH host', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      seedRemoteClaudeUsage(target, Date.now())

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerRemote(orcaPage, target)

      const summaries = await orcaPage.evaluate(async () => {
        await window.api.claudeUsage.setEnabled({ enabled: true })
        await window.api.claudeUsage.refresh({ force: true })
        return {
          orca: await window.api.claudeUsage.getSummary({ scope: 'orca', range: '30d' }),
          all: await window.api.claudeUsage.getSummary({ scope: 'all', range: '30d' })
        }
      })
      // Only the transcript whose cwd is the remote Orca worktree counts as Orca usage.
      expect(summaries.orca).toMatchObject({ sessions: 1, inputTokens: 4321 })
      expect(summaries.all).toMatchObject({ sessions: 2, inputTokens: 5321 })

      await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
      await expect
        .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
        .toBe('settings')
      await orcaPage.getByRole('button', { name: 'Stats & Usage' }).click()
      const providerDropdown = orcaPage.getByTestId('usage-provider-select')
      await providerDropdown.click()
      await orcaPage.getByRole('menuitem', { name: 'Claude', exact: true }).click()
      await expect(orcaPage.getByRole('heading', { name: 'Claude Usage Tracking' })).toBeVisible()
      await expect(orcaPage.getByText('4.3k').first()).toBeVisible({ timeout: 30_000 })
      await orcaPage.screenshot({
        path: testInfo.outputPath('ssh-claude-usage.png'),
        fullPage: true
      })
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
