import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AGENT_STATUS_LEGACY_INGRESS_MANIFEST,
  currentProducerAgentStatusLegacyIngressManifest
} from './agent-status-legacy-ingress-manifest'
import { findAgentStatusLegacyMutationBypasses } from './agent-status-legacy-source-scan'
import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'

const SOURCE_ROOT = resolve(__dirname, '..')
const ADMISSION_CALL = /admitLegacyAgentStatus\(\s*(?:this\.)?state\s*,\s*['"]([^'"]+)['"]/gs

function describeBypasses(source: string): string[] {
  return findAgentStatusLegacyMutationBypasses(source).map(
    (bypass) => `${bypass.kind}: ${bypass.detail}`
  )
}

// Why: `passed-map` has two independent producing sites, so a deduplicated kind set
// stayed green whenever only one of them broke. Pin each planted form to its own case.
const PLANTED_MUTATION_BYPASSES = [
  {
    bypass: 'direct mutator on the legacy map',
    source: `state.lastStatusByPaneKey.set('pane', row)`,
    expected: ['direct-mutation: lastStatusByPaneKey mutator call']
  },
  {
    bypass: 'mutator via the bracket-indexed key',
    source: `state['lastStatusByPaneKey'].set('pane', row)`,
    expected: ['direct-mutation: lastStatusByPaneKey mutator call']
  },
  {
    bypass: 'mutator on an assigned alias',
    source: `
      const alias = state.lastStatusByPaneKey
      alias.delete('pane')
    `,
    expected: ['alias-mutation: alias mutates an aliased status map']
  },
  {
    bypass: 'mutator on a destructured alias',
    source: `
      const { lastStatusByPaneKey } = state
      lastStatusByPaneKey.clear()
    `,
    expected: [
      'direct-mutation: lastStatusByPaneKey mutator call',
      'alias-mutation: lastStatusByPaneKey mutates an aliased status map'
    ]
  },
  {
    bypass: 'cast back to a mutable Map',
    source: `;(state.lastStatusByPaneKey as unknown as Map<string, Row>).clear()`,
    expected: ['map-cast: lastStatusByPaneKey cast back to a mutable Map']
  },
  {
    bypass: 'raw map passed to a function',
    source: `mutateStatusMap(state.lastStatusByPaneKey)`,
    expected: ['passed-map: lastStatusByPaneKey is passed to another function']
  },
  {
    bypass: 'aliased map passed to a function',
    source: `
      const { lastStatusByPaneKey: passed } = state
      mutateStatusMap(passed)
    `,
    expected: ['passed-map: passed is passed to another function']
  }
] as const

describe('legacy agent-status ingress ratchet', () => {
  const productionFiles = scanSourceTree(SOURCE_ROOT)

  it('keeps every production admission call in the explicit manifest', () => {
    const actual = new Set<string>()
    let parsedCalls = 0
    let rawCalls = 0
    for (const file of productionFiles) {
      if (file.relativePath === 'shared/agent-hook-listener/listener-state.ts') {
        continue
      }
      const source = stripComments(file.source)
      rawCalls += source.match(/\badmitLegacyAgentStatus\s*\(/g)?.length ?? 0
      for (const match of source.matchAll(ADMISSION_CALL)) {
        parsedCalls += 1
        actual.add(`src/${file.relativePath}:${match[1]}`)
      }
    }
    expect(parsedCalls, 'Every admission must pass a literal caller id directly.').toBe(rawCalls)

    const declared = new Set(
      AGENT_STATUS_LEGACY_INGRESS_MANIFEST.map((entry) => `${entry.sourcePath}:${entry.caller}`)
    )
    expect([...actual].filter((call) => !declared.has(call))).toEqual([])
    expect([...declared].filter((call) => !actual.has(call))).toEqual([])

    const indirectAdmissions = productionFiles
      .filter((file) =>
        /\badmitLegacyAgentStatus\s+as\s+|=\s*admitLegacyAgentStatus\b|\(\s*admitLegacyAgentStatus\s*[,)]/.test(
          stripComments(file.source)
        )
      )
      .map((file) => file.relativePath)
    expect(indirectAdmissions).toEqual([])
  })

  it('allows no mutable Map path around the adapter', () => {
    const bypasses = productionFiles
      .filter((file) => file.source.includes('lastStatusByPaneKey'))
      .flatMap((file) =>
        describeBypasses(file.source).map((bypass) => `${file.relativePath}: ${bypass}`)
      )
    expect(bypasses).toEqual([])
  })

  it.each(PLANTED_MUTATION_BYPASSES)('detects $bypass', ({ source, expected }) => {
    expect(describeBypasses(source)).toEqual(expected)
  })

  it('detects every planted shape together, with none masking another', () => {
    expect(
      describeBypasses(`
        state.lastStatusByPaneKey.set('pane', row)
        const alias = state.lastStatusByPaneKey
        alias.delete('pane')
        const { lastStatusByPaneKey } = state
        lastStatusByPaneKey.clear()
        ;(state.lastStatusByPaneKey as unknown as Map<string, Row>).clear()
        state['lastStatusByPaneKey'].set('pane', row)
        mutateStatusMap(state.lastStatusByPaneKey)
        const { lastStatusByPaneKey: passed } = state
        mutateStatusMap(passed)
      `)
    ).toEqual([
      'direct-mutation: lastStatusByPaneKey mutator call',
      'map-cast: lastStatusByPaneKey cast back to a mutable Map',
      'alias-mutation: alias mutates an aliased status map',
      'alias-mutation: lastStatusByPaneKey mutates an aliased status map',
      'passed-map: passed is passed to another function',
      'passed-map: lastStatusByPaneKey is passed to another function'
    ])
  })

  it('keeps the manifest immutable, descriptive, and partitioned by its exit gate', () => {
    expect(Object.isFrozen(AGENT_STATUS_LEGACY_INGRESS_MANIFEST)).toBe(true)
    const currentProducerManifest = currentProducerAgentStatusLegacyIngressManifest()
    expect(currentProducerManifest.length).toBeGreaterThan(0)
    expect(currentProducerAgentStatusLegacyIngressManifest()).toBe(currentProducerManifest)
    expect(Object.isFrozen(currentProducerManifest)).toBe(true)
    expect(new Set(AGENT_STATUS_LEGACY_INGRESS_MANIFEST.map((entry) => entry.caller)).size).toBe(
      AGENT_STATUS_LEGACY_INGRESS_MANIFEST.length
    )
    for (const entry of AGENT_STATUS_LEGACY_INGRESS_MANIFEST) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.allowedModes)).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(20)
      expect(entry.gate.length).toBeGreaterThan(20)
      expect(['2B', '6']).toContain(entry.destination)
    }
  })

  it('keeps adapter construction and test seeding behind listener-state', () => {
    const forbidden = productionFiles
      .filter(
        (file) =>
          file.relativePath !== 'shared/agent-hook-listener/listener-state.ts' &&
          file.relativePath !== 'shared/agent-status-legacy-adapter.ts'
      )
      .filter(
        (file) =>
          stripComments(file.source).includes('createAgentStatusLegacyAdapter') ||
          stripComments(file.source).includes('seedLegacyAgentStatusForTests')
      )
      .map((file) => file.relativePath)
    expect(forbidden).toEqual([])
  })

  it('requires every production remote ingress to name the unsupported-peer capability source', () => {
    const callers = productionFiles.filter((file) => /\.ingestRemote\s*\(/.test(file.source))
    expect(callers.map((file) => file.relativePath).sort()).toEqual([
      'main/agent-hooks/wsl-hook-relay-deps.ts',
      'main/ssh/ssh-relay-session.ts'
    ])
    // Why: a bare import of the constant (unused elsewhere) would pass a substring check
    // without ever stamping it onto the envelope — require the actual key:value binding.
    for (const caller of callers) {
      expect(stripComments(caller.source)).toMatch(
        /advertisedAgentStatusCapabilities\s*:\s*AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES\b/
      )
    }
  })

  it('keeps run-capability advertisement behind the serving gate', () => {
    const constantUsers = productionFiles
      .filter((file) => file.source.includes('AGENT_STATUS_RUNS_RUNTIME_CAPABILITY'))
      .map((file) => file.relativePath)
      .sort()
    expect(constantUsers).toEqual([
      'shared/agent-status-run-capability.ts',
      'shared/agent-status-serving-readiness.ts'
    ])
    const literalUsers = productionFiles
      .filter((file) => /['"]agent-status\.runs\.v1['"]/.test(file.source))
      .map((file) => file.relativePath)
    expect(literalUsers).toEqual(['shared/agent-status-run-capability.ts'])
  })
})
