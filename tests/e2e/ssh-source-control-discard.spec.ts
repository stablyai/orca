import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

function seedDiscardState(target: DockerSshRelayTarget): void {
  execDockerSshRelayTargetCommand(
    target,
    [
      `cd ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
      `printf 'staged content\n' > staged.txt`,
      'git add staged.txt',
      `printf 'staged content\nunstaged content\n' > staged.txt`,
      `printf 'intent content\n' > intent.txt`,
      'git add -N intent.txt'
    ].join(' && ')
  )
}

test.describe('Docker SSH Source Control discard', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH discard uses POSIX OpenSSH tooling.')

  test('preserves remote staged content and atomically discards staged content', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      seedDiscardState(target)
      testInfo.annotations.push({
        type: 'docker-ssh-git-discard',
        description: `${target.containerName}:${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}`
      })

      await orcaPage.evaluate(
        async ({ connectionId, worktreePath }) => {
          await window.api.git.bulkDiscard({
            connectionId,
            worktreePath,
            filePaths: ['staged.txt', 'intent.txt']
          })
        },
        {
          connectionId: remote.targetId,
          worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
        }
      )

      const state = execDockerSshRelayTargetCommand(
        target,
        [
          `cd ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
          'git diff --cached -- staged.txt',
          `printf '\n--WORKTREE--\n'`,
          'cat staged.txt',
          `printf '%s\n' '--STATUS--'`,
          'git status --porcelain=v1',
          `printf '%s\n' '--INTENT--'`,
          `test ! -e intent.txt && printf 'absent\n'`
        ].join(' && ')
      )
      expect(state).toContain('+staged content\n')
      expect(state).toContain('--WORKTREE--\nstaged content\n--STATUS--\nA  staged.txt')
      expect(state).toContain('--INTENT--\nabsent')

      await orcaPage.evaluate(
        async ({ connectionId, worktreePath }) => {
          await window.api.git.bulkDiscardStaged({
            connectionId,
            worktreePath,
            filePaths: ['staged.txt'],
            operationId: crypto.randomUUID()
          })
        },
        {
          connectionId: remote.targetId,
          worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
        }
      )

      const discardedState = execDockerSshRelayTargetCommand(
        target,
        [
          `cd ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
          `test ! -e staged.txt && printf 'absent\n'`,
          `test -z "$(git status --porcelain=v1)" && printf 'clean\n'`
        ].join(' && ')
      )
      expect(discardedState).toBe('absent\nclean')
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
