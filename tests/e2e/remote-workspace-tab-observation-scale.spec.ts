import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('keeps target 65 and unrelated targets isolated across 1,000 renderer IPC observations', async ({
  orcaPage
}) => {
  const result = await orcaPage.evaluate(async () => {
    const api = window.api.remoteWorkspace
    const generation = await api.startTabStateObservation()
    const worktreePath = '/remote/work'
    const observedTab = (id: string, createdAt: number) => ({
      processIdentity: `process-${id}`,
      tab: {
        id,
        worktreePath,
        ptyId: `pty-${id}`,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt
      }
    })
    const existing = observedTab('existing', 1)
    const created = observedTab('created', 2)
    const observe = (
      targetId: string,
      tabs: ReturnType<typeof observedTab>[],
      authoritative = false
    ) =>
      api.observeTabState({
        ...(authoritative ? { authoritative: true } : {}),
        hydrated: true,
        rendererGeneration: generation,
        targetId,
        worktrees: [
          {
            worktreeId: `repo-${targetId}::${worktreePath}`,
            worktreeInstanceId: `instance-${targetId}`,
            worktreePath,
            tabs
          }
        ]
      })
    const snapshot = (revision: number, tabs: ReturnType<typeof observedTab>[]) => ({
      namespace: 'scale-test',
      revision,
      updatedAt: revision,
      schemaVersion: 1,
      session: {
        activeWorktreePath: worktreePath,
        activeTabId: tabs[0]?.tab.id ?? null,
        tabsByWorktreePath: { [worktreePath]: tabs.map((entry) => entry.tab) },
        terminalLayoutsByTabId: {}
      }
    })

    for (let index = 1; index <= 64; index += 1) {
      await observe(`target-${index}`, [], true)
    }
    await observe('target-65', [existing], true)
    await observe('target-65', [existing, created])
    for (let index = 66; index <= 1_000; index += 1) {
      await observe(`target-${index}`, [], true)
    }
    const retained = await api.reconcileSnapshot({
      targetId: 'target-65',
      snapshot: snapshot(2, [existing])
    })
    const unrelatedBeforeCleanup = await api.reconcileSnapshot({
      targetId: 'target-1000',
      snapshot: snapshot(2, [existing])
    })

    await api.forgetTabState({ rendererGeneration: generation, targetId: 'target-999' })
    await observe('target-1000', [existing])
    await observe('target-1000', [existing, created])
    const unrelatedMutation = await api.reconcileSnapshot({
      targetId: 'target-1000',
      snapshot: snapshot(3, [existing])
    })
    return {
      unrelatedMutation:
        unrelatedMutation?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? [],
      retained: retained?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? [],
      unrelatedBeforeCleanup:
        unrelatedBeforeCleanup?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
    }
  })

  expect(result).toEqual({
    unrelatedMutation: ['existing', 'created'],
    retained: ['existing', 'created'],
    unrelatedBeforeCleanup: ['existing']
  })
})
