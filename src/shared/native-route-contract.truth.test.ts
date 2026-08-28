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

  it('opencode IS a native route: Orca launches, resumes and observes it', () => {
    const capability = resolveNativeRouteCapability('opencode', 'glm-5.3')
    // Orca has a launch configuration for it...
    expect(capability.launcherSupported).toBe(true)
    // ...and receives its hook events through OpenCode's own plugin, even
    // though Orca does not install managed hook scripts into it. Conflating
    // those two facts is what wrongly reported this route as unsupported.
    expect(capability.hookSupported).toBe(true)
    // What is genuinely missing is a session-option catalog, so Orca cannot
    // pin or verify the model through its own contract.
    expect(capability.hasCatalog).toBe(false)
    expect(classifyNativeRoute({ agent: 'opencode', model: 'glm-5.3' }).verdict).toBe(
      'IDENTITY_PROOF_INCOMPLETE'
    )
  })

  it('TRULY_UNSUPPORTED is reserved for no launcher at all, or policy exclusion', () => {
    // Local Qwen is excluded from worker routing by explicit policy.
    expect(classifyNativeRoute({ agent: 'qwen-code', model: 'qwen3.5' }).verdict).toBe(
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

  it('reports BOTH native launch strategies, so a policy verdict never reads as "cannot launch"', () => {
    // Structured worker-start preferences AND a supervised custom terminal are
    // both native launches. Modelling only the first made agents Orca launches
    // perfectly well look unsupported.
    const codex = resolveNativeRouteCapability('codex', 'gpt-5.6-sol')
    expect(codex.launchStrategies).toEqual(['worker_start_preferences', 'custom_terminal_attach'])

    for (const agent of ['gemini', 'grok', 'opencode'] as const) {
      const capability = resolveNativeRouteCapability(agent)
      // Not opted into the structured path...
      expect(capability.launchStrategies, agent).toEqual(['custom_terminal_attach'])
      // ...but Orca can still launch and supervise it natively.
      expect(capability.nativeLaunchPossible, agent).toBe(true)
    }

    // Only a genuine absence of any launcher, or an explicit policy exclusion,
    // means Orca cannot launch at all.
    const excluded = resolveNativeRouteCapability('qwen-code')
    expect(excluded.launchStrategies).toEqual([])
    expect(excluded.nativeLaunchPossible).toBe(false)
  })
})
