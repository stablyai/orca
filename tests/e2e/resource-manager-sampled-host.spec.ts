import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

for (const theme of ['dark', 'light'] as const) {
  test(`sampled local workspace keeps its name and actions with host twins (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 900 })
    await orcaPage.evaluate(async (theme) => {
      const store = window.__store!
      await store.getState().updateSettingsOrThrow({ theme })
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo).flat()[0]
      if (!worktree) {
        throw new Error('Missing seeded local workspace')
      }
      await window.api.pty.spawn({
        cols: 80,
        rows: 24,
        cwd: worktree.path,
        worktreeId: worktree.id,
        initiallyHidden: true
      })
      await store.getState().fetchMemorySnapshot()
      store.setState({
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [worktree.repoId]: [
            { ...worktree, hostId: 'ssh:box', displayName: 'SSH twin' },
            { ...worktree, hostId: 'runtime:paired', displayName: 'Runtime twin' },
            { ...worktree, hostId: 'local', displayName: 'Saved local', isMainWorktree: false }
          ]
        },
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null
      })
    }, theme)
    await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
    const panel = orcaPage.getByRole('dialog')
    await expect(panel.getByText('Resource Manager', { exact: true })).toBeVisible()
    const screenshot = testInfo.outputPath(`sampled-host-${theme}.png`)
    await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach(`sampled-host-${theme}`, { path: screenshot, contentType: 'image/png' })
    const resume = panel.getByRole('button', { name: 'Resume workspace Saved local', exact: true })
    await expect(resume).toBeVisible()
    await resume.focus()
    await expect(
      panel.getByRole('button', { name: 'Delete workspace Saved local', exact: true })
    ).toBeVisible()
    await expect(panel.getByText('SSH twin', { exact: true })).toHaveCount(0)
    await expect(panel.getByText('Runtime twin', { exact: true })).toHaveCount(0)
    await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
  })
}

test('remote readings do not borrow a same-ID local terminal binding', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo).flat()[0]
    const tab = worktree && state.tabsByWorktree[worktree.id]?.[0]
    if (!worktree || !tab) {
      throw new Error('Missing seeded workspace and terminal')
    }
    const snapshot = await window.api.memory.getSnapshot()
    const remoteSnapshot = {
      ...snapshot,
      worktrees: [
        {
          worktreeId: worktree.id,
          worktreeName: 'Remote workspace',
          repoId: worktree.repoId,
          repoName: 'Remote project',
          cpu: 12,
          memory: 900e6,
          history: [],
          sessions: [
            {
              sessionId: 'same-session',
              pid: 44,
              cpu: 12,
              memory: 900e6,
              paneKey: `${tab.id}:123e4567-e89b-42d3-a456-426614174000`
            }
          ]
        }
      ]
    }
    const status = await window.api.runtime.getStatus()
    store.setState({
      runtimeEnvironments: [
        {
          id: 'paired',
          name: 'Paired test host',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: 'paired',
          endpoints: [],
          preferredEndpointId: 'test'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([['paired', { status, checkedAt: Date.now() }]]),
      tabsByWorktree: {
        [worktree.id]: [{ ...tab, customTitle: 'LOCAL TITLE', ptyId: 'same-session' }]
      },
      ptyIdsByTabId: { [tab.id]: ['same-session'] },
      memorySnapshotByHostId: { local: snapshot, 'runtime:paired': remoteSnapshot },
      fetchMemorySnapshot: async () => {},
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null
    })
  })
  await orcaPage.getByRole('button', { name: /^Resource Manager,/ }).click()
  const panel = orcaPage.getByRole('dialog')
  await panel.getByRole('radio', { name: 'Paired test host', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'Resume workspace Remote workspace', exact: true })
  ).toBeVisible()
  const screenshot = testInfo.outputPath('remote-session-binding.png')
  await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('remote-session-binding', { path: screenshot, contentType: 'image/png' })
  await expect(panel.getByText('pid 44', { exact: true })).toBeVisible()
  await expect(panel.getByText('LOCAL TITLE', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /^Delete workspace/ })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /^Kill session/ })).toHaveCount(0)
})
