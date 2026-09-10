import { describe, expect, it } from 'vitest'
import { maestroAutomaticPlacementCandidateKeys } from './useMaestroWorkspaceAutomaticPlacement'

describe('Maestro automatic placement candidates', () => {
  it('repositions externally discovered surfaces even after authority assigned a default', () => {
    expect(
      maestroAutomaticPlacementCandidateKeys({
        additions: ['external-terminal'],
        unplaced: [],
        topologyManaged: []
      })
    ).toEqual(['external-terminal'])
  })

  it('preserves explicit cursor placement from a local create', () => {
    expect(
      maestroAutomaticPlacementCandidateKeys({
        additions: ['local-terminal'],
        unplaced: [],
        topologyManaged: [],
        locallyCreatedSurfaceKey: 'local-terminal'
      })
    ).toEqual([])
    expect(
      maestroAutomaticPlacementCandidateKeys({
        additions: ['local-terminal'],
        unplaced: ['local-terminal'],
        topologyManaged: [],
        locallyCreatedSurfaceKey: 'local-terminal'
      })
    ).toEqual(['local-terminal'])
  })
})
