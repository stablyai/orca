import { describe, expect, it } from 'vitest'
import { classifyNativeRoute, resolveNativeRouteCapability } from './native-route-contract'

/** ORCA_NATIVE_ROUTE_TRUTH — the evidence table the addendum asks for, derived
 *  from native Orca's own catalogs rather than from any launcher allowlist.
 *  If a catalog changes, this test is what tells us the truth table moved.
 */
describe('ORCA_NATIVE_ROUTE_TRUTH', () => {
  it('prints the derived route truth for every provider in scope', () => {
    const rows = [
      { label: 'Opus (Claude)', agent: 'claude' as const, model: 'opus', reasoning: null },
      { label: 'Fable (Claude)', agent: 'claude' as const, model: 'fable', reasoning: null },
      { label: 'Sol (Codex)', agent: 'codex' as const, model: 'gpt-5.6-sol', reasoning: 'xhigh' },
      {
        label: 'Gemini Flash',
        agent: 'gemini' as const,
        model: 'gemini-3-flash-preview',
        reasoning: null
      },
      { label: 'Grok', agent: 'grok' as const, model: 'grok-4.6', reasoning: null },
      { label: 'GLM-5.3 (opencode)', agent: 'opencode' as const, model: 'glm-5.3', reasoning: null }
    ]
    const table = rows.map((row) => {
      const verdict = classifyNativeRoute({
        agent: row.agent,
        model: row.model,
        reasoning: row.reasoning
      })
      return {
        route: row.label,
        agent: row.agent,
        model: row.model,
        verdict: verdict.verdict,
        canPin: verdict.capability.canApplyModelAtLaunch,
        optedIn: verdict.capability.optedIntoWorkerLaunch,
        discovers: verdict.capability.discoversExactModels
      }
    })
    process.stderr.write(`\nNATIVE_ROUTE_TRUTH ${JSON.stringify(table, null, 1)}\n`)
    expect(table).toHaveLength(6)
  })

  it('claude and codex are natively launchable for worker routes', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const capability = resolveNativeRouteCapability(agent)
      expect(capability.canApplyModelAtLaunch, agent).toBe(true)
      expect(capability.optedIntoWorkerLaunch, agent).toBe(true)
    }
  })

  it('gemini and grok are policy drift, NOT provider incapability', () => {
    for (const [agent, model] of [
      ['gemini', 'gemini-3-flash-preview'],
      ['grok', 'grok-4.6']
    ] as const) {
      const capability = resolveNativeRouteCapability(agent, model)
      // The catalog seeds the model AND knows how to put it on the command line.
      expect(capability.models, agent).toContain(model)
      expect(capability.canApplyModelAtLaunch, agent).toBe(true)
      // Only the unattended-launch opt-in is missing.
      expect(capability.optedIntoWorkerLaunch, agent).toBe(false)
      expect(classifyNativeRoute({ agent, model }).verdict).toBe('BLOCKED_SAFE_LAUNCH_POLICY_DRIFT')
    }
  })

  it('opencode has no session-option catalog at all, so GLM is truly unsupported natively', () => {
    const capability = resolveNativeRouteCapability('opencode', 'glm-5.3')
    expect(capability.hasCatalog).toBe(false)
    expect(classifyNativeRoute({ agent: 'opencode', model: 'glm-5.3' }).verdict).toBe(
      'TRULY_UNSUPPORTED'
    )
  })

  it('a Claude family alias is identity-incomplete, not unsupported, because the CLI can be probed', () => {
    const capability = resolveNativeRouteCapability('claude', 'opus')
    expect(capability.models).toContain('opus')
    expect(capability.discoversExactModels).toBe(true)
    // The seeded ids are family aliases; an exact per-host name is discoverable.
    expect(classifyNativeRoute({ agent: 'claude', model: 'claude-opus-5-20260101' }).verdict).toBe(
      'IDENTITY_PROOF_INCOMPLETE'
    )
  })

  it('gemini-3.7-flash is absent from the catalog: the pinned SCL model never existed natively', () => {
    expect(resolveNativeRouteCapability('gemini').models).not.toContain('gemini-3.7-flash')
    expect(resolveNativeRouteCapability('gemini').models).toContain('gemini-3-flash-preview')
  })
})
