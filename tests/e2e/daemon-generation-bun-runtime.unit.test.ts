import { expect, it } from 'vitest'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  spawnGenerationCanary,
  pingGenerationCanary,
  cleanupDaemonGenerationFixtures,
  type DaemonGeneration,
  type GenerationCanary
} from './helpers/daemon-generation-safety-fixtures'
import { processIdentityIsAlive } from './helpers/daemon-generation-processes'

it.skipIf(process.env.ORCA_DAEMON_GENERATION_SMOKE !== '1')(
  'runs current and legacy-protocol real PTY canaries under verified Bun without Electron UI',
  async () => {
    const runtime = await createDaemonGenerationRuntime({
      outputDir: join(process.cwd(), '.build', 'daemon-generation-bun-smoke'),
      outputPath: (...parts: string[]) =>
        join(process.cwd(), '.build', 'daemon-generation-bun-smoke', ...parts)
    })
    const generations: DaemonGeneration[] = []
    const canaries: GenerationCanary[] = []
    try {
      for (const protocolVersion of [PROTOCOL_VERSION, PROTOCOL_VERSION - 1]) {
        const generation = await launchDaemonGeneration({
          runtime,
          label: `protocol-${protocolVersion}`,
          protocolVersion
        })
        generations.push(generation)
        const canary = await spawnGenerationCanary({ runtime, generation, role: 'live' })
        canaries.push(canary)
        await pingGenerationCanary(canary, 'first')
      }
      for (const canary of canaries) {
        expect(await processIdentityIsAlive(canary.rootIdentity)).toBe(true)
        expect(await processIdentityIsAlive(canary.descendantIdentity)).toBe(true)
        await pingGenerationCanary(canary, 'still-live')
      }
    } finally {
      runtime.retainDiagnostics(generations)
      await cleanupDaemonGenerationFixtures({ generations, canaries })
      runtime.remove()
    }
  },
  90_000
)
