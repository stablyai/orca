import { describe, expect, it } from 'vitest'
import { mountWorker } from '../declarative/testing/testing-worker'
import { createMockHost } from '../declarative/testing/testing-host'
import type { PluginWorkerOrcaApi } from './plugin-worker-orca-api'

describe('panels.post', () => {
  it('throws too_large for a payload main would drop, and sends only what fits', async () => {
    const thrown: unknown[] = []
    const mounted = await mountWorker(
      {
        default(orca: PluginWorkerOrcaApi) {
          const tooLarge = ['x'.repeat(256 * 1024 + 1), Array.from({ length: 10_001 }, () => ({}))]
          for (const payload of tooLarge) {
            try {
              orca.panels.post('board.changed', payload)
            } catch (error) {
              thrown.push(error)
            }
          }
          orca.panels.post('board.changed', 'x'.repeat(256 * 1024))
        }
      },
      { host: createMockHost({}, []), events: [], commands: [], hooks: [] }
    )

    expect(thrown).toMatchObject([
      {
        code: 'too_large',
        message: 'orca.panels.post("board.changed"): the payload is over 256 KiB'
      },
      {
        code: 'too_large',
        message:
          'orca.panels.post("board.changed"): the payload holds more than 10,000 objects and arrays'
      }
    ])
    expect(mounted.posts).toHaveLength(1)
  })
})
