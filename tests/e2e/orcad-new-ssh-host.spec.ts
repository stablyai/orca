import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import type { OrcadHealth } from '../../src/main/orcad/orcad-health'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

test.skip(
  process.env.ORCA_REVIEW_ORCAD_SSH_UI_LIFECYCLE !== '1',
  'Run through config/scripts/orcad-bun-ssh-ui-e2e.mjs'
)
test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

async function rpc<T>(page: Page, selector: string, method: string, params: unknown): Promise<T> {
  const response = await page.evaluate((request) => window.api.runtimeEnvironments.call(request), {
    selector,
    method,
    params
  })
  if (!response.ok) {
    throw new Error(`${method}: ${response.error.message}`)
  }
  return response.result as T
}

test('new SSH host installs the paired Bun backend without host Node or npm', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(360_000)
  let target: DockerSshRelayTarget | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    // Only this disposable container is changed; leave the shared fixture image intact.
    execDockerSshRelayTargetCommand(
      target,
      'mkdir /tmp/orca-disabled-node && mv /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /tmp/orca-disabled-node/'
    )
    const absentNode =
      'if command -v node || command -v npm; then exit 1; fi; printf NODE_NPM_ABSENT'
    expect(execDockerSshRelayTargetCommand(target, absentNode)).toBe('NODE_NPM_ABSENT')
    const name = `No Node SSH ${randomUUID().slice(0, 8)}`
    await orcaPage.evaluate(() => {
      window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      state.openSettingsTarget({ pane: 'servers', repoId: null })
      state.openSettingsPage()
    })
    await orcaPage.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Add Target', exact: true }).click()
    const form = orcaPage.getByRole('dialog', { name: 'Add SSH host', exact: true })
    await form.getByLabel('Label', { exact: true }).fill(name)
    await form.getByLabel('Host or alias *', { exact: true }).fill(target.host)
    await form.getByLabel('Username', { exact: true }).fill('root')
    await form.getByLabel('Port', { exact: true }).fill(String(target.port))
    await form.getByLabel('Identity File', { exact: true }).fill(target.identityFile)
    await form.getByRole('button', { name: 'Install server', exact: true }).click()
    await expect(form).not.toBeVisible({ timeout: 180_000 })

    const environments = await orcaPage.evaluate(() => window.api.runtimeEnvironments.list())
    const matching = environments.filter((environment) => environment.name === name)
    expect(matching).toHaveLength(1)
    const environment = matching[0]
    expect(environment.orcadDeployment).toBeDefined()
    const selector = environment.id
    expect(
      await orcaPage.evaluate(() =>
        window.api.runtimeEnvironments.listPendingOrcadSshProvisioning()
      )
    ).toEqual([])
    const rawTargets = await orcaPage.evaluate(() => window.api.ssh.listTargets())
    expect(rawTargets.filter((candidate) => candidate.label === name)).toEqual([])

    await orcaPage.getByRole('button', { name: 'Remote Orca Servers Beta', exact: true }).click()
    const section = orcaPage.locator('[data-settings-section="managed-orcad-servers"]')
    await expect(section.getByText(name, { exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('new-ssh-host-installed.png') })
    const health = await rpc<OrcadHealth>(orcaPage, selector, 'orcad.health', {})
    expect(health.runtimeKind).toBe('bun')
    expect(health.runtimeVersion).toBe(ORCAD_BUN_VERSION)
    expect(health.ptyBackend).toBe('bun-terminal')
    expect(health.terminalDaemon.runtimeKind).toBe('bun')
    expect(health.terminalDaemon.runtimeVersion).toBe(ORCAD_BUN_VERSION)
    expect(execDockerSshRelayTargetCommand(target, absentNode)).toBe('NODE_NPM_ABSENT')

    const { repo } = await rpc<{ repo: { id: string } }>(orcaPage, selector, 'repo.add', {
      path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
    })
    const { worktrees } = await rpc<{ worktrees: { id: string; path: string }[] }>(
      orcaPage,
      selector,
      'worktree.list',
      { repo: `id:${repo.id}`, limit: 100 }
    )
    const worktree = worktrees.find((row) => row.path === DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    if (!worktree) {
      throw new Error('Remote repository worktree was not listed')
    }
    const folderPath = '/tmp/orca-new-host-folder'
    execDockerSshRelayTargetCommand(target, `mkdir ${folderPath}`)
    const { group } = await rpc<{ group: { id: string } }>(
      orcaPage,
      selector,
      'projectGroup.create',
      {
        name: 'Non-git project',
        parentPath: folderPath
      }
    )
    const { folderWorkspace } = await rpc<{ folderWorkspace: { id: string } }>(
      orcaPage,
      selector,
      'folderWorkspace.create',
      { projectGroupId: group.id, name: 'Non-git workspace', folderPath }
    )
    for (const workspaceSelector of [worktree.id, `id:${folderWorkspaceKey(folderWorkspace.id)}`]) {
      const { terminal } = await rpc<{ terminal: { handle: string } }>(
        orcaPage,
        selector,
        'terminal.create',
        { worktree: workspaceSelector }
      )
      const marker = randomUUID()
      await rpc(orcaPage, selector, 'terminal.send', {
        terminal: terminal.handle,
        text: `printf 'ORCA_%s_%s\\n' HOST ${marker}`,
        enter: true
      })
      await expect
        .poll(
          async () =>
            JSON.stringify(
              await rpc(orcaPage, selector, 'terminal.read', {
                terminal: terminal.handle,
                limit: 1_000
              })
            ),
          { timeout: 30_000 }
        )
        .toContain(`ORCA_HOST_${marker}`)
      await rpc(orcaPage, selector, 'terminal.close', { terminal: terminal.handle })
    }
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
})
