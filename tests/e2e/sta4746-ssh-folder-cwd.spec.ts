import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetControlCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { test, expect } from './helpers/orca-app'
import {
  closeSta4746Tabs,
  probeWorkspaceTerminal,
  type Sta4746Probe
} from './helpers/sta4746-cwd-probe'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_FOLDER_PARENT = '/srv/sta4746'
const REMOTE_FOLDER_PATH = `${REMOTE_FOLDER_PARENT}/workspace`
const REMOTE_PROFILE_CD_PATH = `${REMOTE_FOLDER_PARENT}/container-init`
// Why: the profile script records where each login shell *started*, before it
// cd's. That is independent of OLDPWD, which could otherwise be inherited.
const REMOTE_PRE_CD_LOG = `${REMOTE_FOLDER_PARENT}/pre-cd.log`

test.describe('STA-4746 SSH relay folder workspace cwd', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker SSH relay repro')
  test.skip(process.platform === 'win32', 'Probes and the Docker target are POSIX-only')

  test('relay honours the folder-workspace path; a login-profile cd is what moves it', async ({
    orcaPage: page
  }, testInfo) => {
    test.setTimeout(420_000)
    let target: DockerSshRelayTarget | null = null
    const tabIds: string[] = []
    try {
      target = startDockerSshRelayTarget(testInfo)
      execDockerSshRelayTargetControlCommand(
        target,
        `mkdir -p ${REMOTE_FOLDER_PATH} ${REMOTE_PROFILE_CD_PATH}`
      )
      await waitForSessionReady(page)
      await waitForActiveWorktree(page)
      const connected = await connectDockerSshRelayTarget(page, target)
      const connectionId = connected.targetId
      const gitWorktreeKey = connected.worktreeId
      // Why the exact id: `ssh:<anything>@@` would also accept a second target
      // that happens to expose the same paths.
      const sshOwner = new RegExp(`^ssh:${connectionId}@@`)

      const probe = async (workspaceKey: string, phase: string): Promise<Sta4746Probe> => {
        const run = await probeWorkspaceTerminal({
          page,
          workspaceKey,
          phase,
          expectedPtyOwner: sshOwner,
          // The kernel's answer for this exact shell — a second signal that
          // cannot agree with $PWD by construction.
          extraFields: { selfcwd: '"$(readlink /proc/$$/cwd)"' }
        })
        tabIds.push(run.tabId)
        return run.probe
      }

      const folderWorkspaceId = await page.evaluate(
        async ({ connectionId, parentPath, folderPath }) => {
          const group = await window.api.projectGroups.create({
            name: `sta4746-${Date.now()}`,
            parentPath,
            connectionId,
            createdFrom: 'manual'
          })
          const workspace = await window.api.folderWorkspaces.create({
            projectGroupId: group.id,
            name: 'sta4746-ws',
            folderPath,
            connectionId
          })
          return workspace.id as string
        },
        { connectionId, parentPath: REMOTE_FOLDER_PARENT, folderPath: REMOTE_FOLDER_PATH }
      )
      const workspaceKey = `folder:${folderWorkspaceId}`
      await expect
        .poll(
          async () =>
            page.evaluate(
              (id) =>
                (window.__store?.getState().folderWorkspaces ?? []).some(
                  (workspace) => workspace.id === id
                ),
              folderWorkspaceId
            ),
          { timeout: 30_000, message: 'folder workspace never landed in the renderer store' }
        )
        .toBe(true)

      // Phase A — clean remote login profile. The relay must land in the folder path.
      const clean = await probe(workspaceKey, 'clean-folder')
      expect(clean.pwd).toBe(REMOTE_FOLDER_PATH)
      expect(clean.selfcwd).toBe(REMOTE_FOLDER_PATH)
      expect(clean.root).toBe(REMOTE_FOLDER_PATH)
      expect(clean.wt).toBe(workspaceKey)

      // Phase B — the host's login startup chain runs after the PTY is placed
      // (zsh gets `-l`; bash's relay wrapper sources /etc/profile itself, see
      // src/relay/pty-shell-overlay-wrappers.ts). A `cd` there therefore wins,
      // producing the STA-4746 reporter's signature with no Orca defect.
      execDockerSshRelayTargetControlCommand(
        target,
        `printf 'printf "%%s\\\\n" "$PWD" >> ${REMOTE_PRE_CD_LOG}\\ncd ${REMOTE_PROFILE_CD_PATH}\\n' > /etc/profile.d/99-sta4746-cd.sh`
      )
      const profiled = await probe(workspaceKey, 'profile-cd-folder')
      expect(profiled.pwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiled.selfcwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiled.oldpwd).toBe(REMOTE_FOLDER_PATH)
      expect(profiled.root).toBe(REMOTE_FOLDER_PATH)
      expect(
        execDockerSshRelayTargetControlCommand(target, `tail -n 1 ${REMOTE_PRE_CD_LOG}`).trim()
      ).toBe(REMOTE_FOLDER_PATH)

      // Phase C — the same login-profile cd moves a plain git worktree too, so
      // the symptom is not specific to `folder:<uuid>` workspace ids.
      const profiledWorktree = await probe(gitWorktreeKey, 'profile-cd-worktree')
      expect(profiledWorktree.pwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiledWorktree.oldpwd).toBe(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
      expect(profiledWorktree.root).toBe('')
      expect(
        execDockerSshRelayTargetControlCommand(target, `tail -n 1 ${REMOTE_PRE_CD_LOG}`).trim()
      ).toBe(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    } finally {
      await closeSta4746Tabs(page, tabIds)
      cleanupDockerSshRelayTarget(target)
    }
  })
})
