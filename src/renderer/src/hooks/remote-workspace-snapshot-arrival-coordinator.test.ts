import { expect, it } from 'vitest'
import { createRemoteWorkspaceSnapshotArrivalCoordinator } from './remote-workspace-snapshot-arrival-coordinator'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

it('releases completed generations across repeated target churn', async () => {
  const coordinator = createRemoteWorkspaceSnapshotArrivalCoordinator()
  const arrivals: number[] = []

  for (let index = 0; index < 128; index += 1) {
    const targetId = `target-${index % 8}`
    await coordinator.run(targetId, async (arrival) => {
      arrivals.push(arrival)
    })
    expect(coordinator.isCurrent(targetId, 1)).toBe(false)
  }

  expect(new Set(arrivals)).toEqual(new Set([1]))
})

it('does not reuse a generation while an aborted operation is still settling', async () => {
  const coordinator = createRemoteWorkspaceSnapshotArrivalCoordinator()
  const firstCanFinish = deferred()
  const thirdCanFinish = deferred()
  const arrivals: number[] = []
  let firstStillCurrent = true

  const first = coordinator.run('target-a', async (arrival) => {
    arrivals.push(arrival)
    await firstCanFinish.promise
    firstStillCurrent = coordinator.isCurrent('target-a', arrival)
  })
  await coordinator.run('target-a', async (arrival) => {
    arrivals.push(arrival)
  })
  const third = coordinator.run('target-a', async (arrival) => {
    arrivals.push(arrival)
    await thirdCanFinish.promise
  })

  expect(arrivals).toEqual([1, 2, 3])

  firstCanFinish.resolve()
  await first
  expect(firstStillCurrent).toBe(false)

  thirdCanFinish.resolve()
  await third
  expect(coordinator.isCurrent('target-a', 3)).toBe(false)
})
