import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyPeerReplacements,
  replacedRuntimeEnvironmentIds,
  resetDeferredPeerChecksForTests
} from './runtime-environment-peer-replacement'

afterEach(() => resetDeferredPeerChecksForTests())

function managed(
  overrides: { generation?: number; pairingRevision?: number; hostKey?: string | null } = {}
) {
  return {
    id: 'env-1',
    createdAt: 1,
    pairingRevision: overrides.pairingRevision ?? 1,
    ...(overrides.hostKey === null ? {} : { hostKeyFingerprint: overrides.hostKey ?? 'key-a' }),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: overrides.generation ?? 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function retired(previous: ReturnType<typeof managed>, next: ReturnType<typeof managed>): string[] {
  return classifyPeerReplacements(
    [previous],
    [next],
    replacedRuntimeEnvironmentIds([previous], [next])
  ).retired
}

describe('which re-paired environments name a different machine', () => {
  it('defers a re-pair whose host key is not known yet instead of retiring it', () => {
    expect(retired(managed(), managed({ pairingRevision: 2, hostKey: null }))).toEqual([])
    expect(
      classifyPeerReplacements(
        [managed({ pairingRevision: 2, hostKey: null })],
        [managed({ pairingRevision: 2, hostKey: 'key-b' })],
        []
      ).retired
    ).toEqual(['env-1'])
  })
})

describe('which re-pairs a live pane may follow', () => {
  const classify = (previous: ReturnType<typeof managed>, next: ReturnType<typeof managed>) =>
    classifyPeerReplacements([previous], [next], replacedRuntimeEnvironmentIds([previous], [next]))

  it('reports a deferred re-pair only once its key proves the same host, from the original pairing', () => {
    expect(classify(managed(), managed({ pairingRevision: 2, hostKey: null }))).toEqual({
      retired: [],
      sameHost: [],
      pending: [{ id: 'env-1', fromRevision: 1 }]
    })
    expect(
      classifyPeerReplacements(
        [managed({ pairingRevision: 2, hostKey: null })],
        [managed({ pairingRevision: 2 })],
        []
      )
    ).toEqual({
      retired: [],
      sameHost: [{ id: 'env-1', fromRevision: 1, toRevision: 2 }],
      pending: []
    })
  })
})
