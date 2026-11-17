import { expect, it } from 'vitest'
import { createMockHost } from './testing-host'
import { mountWorker } from './testing-worker'

const event = {
  agent: 'claude',
  workspaceId: null,
  workspaceKind: null,
  command: 'claude',
  env: {}
}

it('hooks.fire runs an agent.launch.before handler only for the launch kinds it lists, as Orca does', async () => {
  const seen: unknown[] = []
  const worker = await mountWorker(
    {
      default: (orca: {
        hooks: { on(name: string, handler: (e: unknown, next: () => unknown) => unknown): void }
      }) => {
        orca.hooks.on('agent.launch.before', (e, next) => {
          seen.push(e)
          return next()
        })
      }
    },
    {
      host: createMockHost({}, []),
      events: [],
      commands: null,
      hooks: [{ event: 'agent.launch.before', launchKinds: ['resume'] }]
    }
  )

  // An event written before launchKind existed is a new launch, which this plugin does not list.
  expect(await worker.hooks.fire('agent.launch.before', event)).toEqual({ kind: 'continue', event })
  expect(seen).toEqual([])

  await worker.hooks.fire('agent.launch.before', { ...event, launchKind: 'resume' })
  expect(seen).toEqual([{ ...event, launchKind: 'resume' }])
})
