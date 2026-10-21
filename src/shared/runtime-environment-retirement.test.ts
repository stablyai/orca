import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import { getEnvironmentStorePath, listEnvironments } from './runtime-environment-store'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'
import { setRuntimeEnvironmentRetirement } from './runtime-environment-retirement'

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:46768',
  deviceToken: 'private-device-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

describe('runtime environment retirement', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-retirement-'))
    addManagedOrcadEnvironment(userDataPath, {
      id: 'environment-1',
      name: 'Machine server',
      pairingCode,
      orcadDeployment: {
        sshTargetId: 'machine-1',
        sshTargetGeneration: 1,
        localPort: 46_768,
        remotePort: 6_768
      },
      now: 100
    })
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('marks a server retired without touching the file older builds rewrite, then lifts it', () => {
    setRuntimeEnvironmentRetirement(userDataPath, 'environment-1', '2026-10-19T00:00:00.000Z')
    const [retired] = listEnvironments(userDataPath)
    expect(retired).toMatchObject({ id: 'environment-1', retiredAt: '2026-10-19T00:00:00.000Z' })
    // The deployment link survives alongside the marker.
    expect(retired?.orcadDeployment).toMatchObject({ sshTargetId: 'machine-1' })
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).not.toContain('retiredAt')

    setRuntimeEnvironmentRetirement(userDataPath, 'environment-1', null)
    expect(listEnvironments(userDataPath)[0]).not.toHaveProperty('retiredAt')
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({
      sshTargetId: 'machine-1'
    })
  })
})
