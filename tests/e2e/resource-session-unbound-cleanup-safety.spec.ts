import { test, expect } from './helpers/orca-app'

test.describe('Resource Manager unbound session cleanup safety', () => {
  test('kills an idle unbound shell while preserving an active unbound session', async ({
    orcaPage,
    testRepoPath
  }) => {
    const spawnedIds: string[] = []

    try {
      const { idleId, activeId } = await orcaPage.evaluate(async (cwd) => {
        // Why: Resource Manager cleanup targets daemon sessions that have no
        // renderer binding, so spawn directly through preload instead of a tab.
        const idle = await window.api.pty.spawn({ cols: 80, rows: 24, cwd })
        const active = await window.api.pty.spawn({ cols: 80, rows: 24, cwd })
        window.api.pty.write(active.id, 'sleep 120\r')
        return { idleId: idle.id, activeId: active.id }
      }, testRepoPath)
      spawnedIds.push(idleId, activeId)

      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ([idle, active]) => {
                const inspections = await window.api.pty.inspectInactiveCleanup([idle, active])
                return Object.fromEntries(inspections.map(({ id, safety }) => [id, safety]))
              },
              [idleId, activeId] as const
            ),
          {
            timeout: 15_000,
            message: 'Idle and active unbound sessions did not become safely distinguishable'
          }
        )
        .toEqual({ [idleId]: 'inactive', [activeId]: 'active' })

      const outcomes = await orcaPage.evaluate(
        (ids) => window.api.pty.killInactiveSessions(ids),
        [idleId, activeId]
      )
      expect(Object.fromEntries(outcomes.map(({ id, outcome }) => [id, outcome]))).toEqual({
        [idleId]: 'killed',
        [activeId]: 'protected-active'
      })

      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ([idle, active]) => ({
                idle: await window.api.pty.hasPty(idle),
                active: await window.api.pty.hasPty(active)
              }),
              [idleId, activeId] as const
            ),
          { message: 'Guarded cleanup did not preserve only the active unbound session' }
        )
        .toEqual({ idle: false, active: true })

      const marker = `ORCA_UNBOUND_SURVIVED_${Date.now()}`
      await orcaPage.evaluate(
        async ({ id, outputMarker }) => {
          window.api.pty.write(id, '\u0003')
          await new Promise((resolve) => setTimeout(resolve, 200))
          window.api.pty.write(id, `printf '${outputMarker}\\n'\r`)
        },
        { id: activeId, outputMarker: marker }
      )
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ id, outputMarker }) => {
                const snapshot = await window.api.pty.getMainBufferSnapshot(id, {
                  scrollbackRows: 100
                })
                return snapshot?.data.includes(outputMarker) ?? false
              },
              { id: activeId, outputMarker: marker }
            ),
          { timeout: 10_000, message: 'Protected active session did not accept later input' }
        )
        .toBe(true)
    } finally {
      await orcaPage.evaluate(async (ids) => {
        await Promise.allSettled(ids.map((id) => window.api.pty.kill(id)))
      }, spawnedIds)
    }
  })
})
