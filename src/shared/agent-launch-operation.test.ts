/** Fingerprint behavioral fields, excluding telemetry: omissions can replay a different launch; extra attribution fields can reject an honest retry. */

import { describe, expect, it } from 'vitest'
import {
  computeAgentLaunchFingerprint,
  type AgentLaunchFingerprintInput
} from './agent-launch-operation'
import { canonicalAgentSessionDigest } from './agent-session/lifecycle/agent-session-mutation-envelope'

const BASE = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: 'wt-1' }
}
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:6fa459ea-ee8a-4ca4-894e-db77e160355e'

/** The handler passes whole wire objects; test runtime exclusion of launchSource rather than its absence from the input type. */
function fingerprintOfWirePayload(
  params: AgentLaunchFingerprintInput & { launchSource?: string }
): string {
  return computeAgentLaunchFingerprint(params)
}

describe('fields the launch fingerprint covers', () => {
  it('covers encoded chat choices while omission keeps the previous digest', () => {
    expect(
      computeAgentLaunchFingerprint({ ...BASE, chatOptions: { model: 'opus', fastMode: 'false' } })
    ).not.toBe(computeAgentLaunchFingerprint(BASE))
    expect(
      computeAgentLaunchFingerprint({ ...BASE, chatOptions: { model: 'opus', fastMode: 'false' } })
    ).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, chatOptions: { model: 'opus', fastMode: 'true' } })
    )
  })

  it('separates two launches that differ only in agentArgs', () => {
    expect(computeAgentLaunchFingerprint({ ...BASE, agentArgs: '--model opus' })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, agentArgs: '--model sonnet' })
    )
  })

  it('treats an explicit "no arguments" as different from falling back to the settings default', () => {
    // Preserve explicit-clear versus default-arguments identity across retries.
    expect(computeAgentLaunchFingerprint({ ...BASE, agentArgs: null })).not.toBe(
      computeAgentLaunchFingerprint(BASE)
    )
  })

  it('separates two launches that differ only in cwd', () => {
    expect(computeAgentLaunchFingerprint({ ...BASE, cwd: '/repo/packages/a' })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, cwd: '/repo/packages/b' })
    )
  })

  it('separates two launches that reserved different panes or sessions', () => {
    // The key is baked into the pane's env; replaying another pane's key strands the new reservation.
    expect(computeAgentLaunchFingerprint({ ...BASE, paneKey: PANE_KEY })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, paneKey: OTHER_PANE_KEY })
    )
    expect(computeAgentLaunchFingerprint({ ...BASE, paneKey: PANE_KEY })).not.toBe(
      computeAgentLaunchFingerprint(BASE)
    )
    const sessionId = '11111111-1111-4111-8111-111111111111'
    expect(computeAgentLaunchFingerprint({ ...BASE, sessionId })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, sessionId: '22222222-2222-4222-8222-222222222222' })
    )
    expect(computeAgentLaunchFingerprint({ ...BASE, sessionId })).not.toBe(
      computeAgentLaunchFingerprint(BASE)
    )
  })

  it('separates a retry that picked another surface, or none, from the first launch', () => {
    const terminal = computeAgentLaunchFingerprint({ ...BASE, surface: 'terminal' })
    expect(terminal).not.toBe(computeAgentLaunchFingerprint({ ...BASE, surface: 'chat' }))
    expect(terminal).not.toBe(computeAgentLaunchFingerprint(BASE))
  })
})

describe('fields the launch fingerprint deliberately ignores', () => {
  it('does not separate two launches that differ only in launchSource', () => {
    // Attribution changes must not turn an identical launch retry into a conflict.
    expect(fingerprintOfWirePayload({ ...BASE, launchSource: 'shortcut' })).toBe(
      fingerprintOfWirePayload({ ...BASE, launchSource: 'tab_bar_quick_launch' })
    )
  })

  it('ignores launchSource entirely, so sending one matches sending none', () => {
    expect(fingerprintOfWirePayload({ ...BASE, launchSource: 'sidebar' })).toBe(
      computeAgentLaunchFingerprint(BASE)
    )
  })
})

describe('compatibility with rows written before these fields existed', () => {
  /** Preserve previous-build digests when new fields are absent so host upgrades do not refuse in-flight retries. */
  it('matches the pre-existing digest when no new field is sent', () => {
    const previousBuild = canonicalAgentSessionDigest({
      method: 'agent.launch',
      agent: BASE.agent,
      target: BASE.target,
      prompt: undefined,
      sessionOptions: undefined,
      reuseTerminal: undefined
    })
    expect(computeAgentLaunchFingerprint(BASE)).toBe(previousBuild)
  })

  it('matches the digest from before the pane key existed when no pane is reserved', () => {
    const beforePaneKey = canonicalAgentSessionDigest({
      method: 'agent.launch',
      agent: BASE.agent,
      target: BASE.target,
      prompt: undefined,
      sessionOptions: undefined,
      reuseTerminal: undefined,
      agentArgs: '--model opus',
      cwd: '/repo/packages/a'
    })
    expect(
      computeAgentLaunchFingerprint({ ...BASE, agentArgs: '--model opus', cwd: '/repo/packages/a' })
    ).toBe(beforePaneKey)
  })
})

describe('transient cwd observation is not launch intent', () => {
  const create = {
    repo: 'id:00000000-0000-4000-8000-000000000099',
    name: 'child',
    displayName: 'child',
    displayNameKind: 'user',
    runHooks: false,
    activate: false,
    cwdParentWorktree:
      'id:00000000-0000-4000-8000-000000000001::/Users/brennanbenson/orca/workspaces/orca/replay-parent::workspace:90ac0c9c-ef88-4f6a-a818-904b4b2c9ada',
    noParent: false,
    callerTerminalHandle: 'term_R',
    cliProvenanceRequest: { callerTerminalHandle: 'term_R' }
  }
  it.each([
    ['term_R', '41860fe80a7d9add36f165fd746ed7b2b68569726a928d05478a09ed4b56f604'],
    ['term_X', '9dcd9a91ee20f6d828a82d0c81bbb2af1d51cde60b45cef42d931958afdcfcf9']
  ])('keeps literal old digest and input bytes for %s', (handle, digest) => {
    const target = {
      kind: 'create-worktree' as const,
      create: {
        ...create,
        callerTerminalHandle: handle,
        cliProvenanceRequest: { callerTerminalHandle: handle }
      }
    }
    const input = { agent: 'codex', target }
    const before = JSON.stringify(input)
    expect(computeAgentLaunchFingerprint(input)).toBe(digest)
    expect(
      computeAgentLaunchFingerprint({
        ...input,
        target: { ...target, create: { ...target.create, cwdParentAmbiguous: true } }
      })
    ).toBe(digest)
    expect(JSON.stringify(input)).toBe(before)
    expect(computeAgentLaunchFingerprint(input)).toBe(
      canonicalAgentSessionDigest({ method: 'agent.launch', ...input })
    )
  })
  it.each([
    { cwdParentWorktree: 'id:another' },
    { parentWorktree: 'id:explicit' },
    { parentWorkspace: 'folder:r' },
    { noParent: true },
    { repo: 'id:other' },
    { name: 'other' },
    { envParentWorkspace: 'folder:s' },
    { callerTerminalHandle: 'term_X' },
    { orchestrationContext: { taskId: 'task_t' } },
    { createIdentity: { instanceId: 'instance' } },
    { futureLegitimateField: true }
  ])('preserves every other create field, including unknown legitimate fields: %j', (change) => {
    const input = { agent: 'codex', target: { kind: 'create-worktree' as const, create } }
    expect(
      computeAgentLaunchFingerprint({
        ...input,
        target: { ...input.target, create: { ...create, ...change, cwdParentAmbiguous: true } }
      })
    ).not.toBe(computeAgentLaunchFingerprint(input))
  })
  it.each<Partial<AgentLaunchFingerprintInput>>([
    { agent: 'claude' },
    { prompt: { text: 'hello', delivery: 'submit' } },
    { sessionOptions: { model: 'model' } },
    { chatOptions: { model: 'model' } },
    { reuseTerminal: { handle: 'term_other' } },
    { agentArgs: null },
    { agentArgs: '--verbose' },
    { cwd: '/another' },
    { paneKey: PANE_KEY },
    { sessionId: 'session_other' },
    { surface: 'terminal' }
  ])('retains outer launch intent and explicit clear with the observation: %j', (change) => {
    const input: AgentLaunchFingerprintInput = {
      agent: 'codex',
      target: { kind: 'create-worktree', create }
    }
    const changed = { ...input, ...change }
    expect(computeAgentLaunchFingerprint(changed)).not.toBe(computeAgentLaunchFingerprint(input))
    expect(computeAgentLaunchFingerprint(changed)).toBe(
      canonicalAgentSessionDigest({ method: 'agent.launch', ...changed })
    )
    expect(
      computeAgentLaunchFingerprint({
        ...changed,
        target: { kind: 'create-worktree', create: { ...create, cwdParentAmbiguous: true } }
      })
    ).toBe(computeAgentLaunchFingerprint(changed))
  })
  it.each(['existing', 'create-folder-workspace'] as const)(
    'does not project %s targets',
    (kind) => {
      const target =
        kind === 'existing'
          ? { kind, worktree: 'id:r' }
          : { kind, create: { name: 'folder', cwdParentAmbiguous: true } }
      expect(computeAgentLaunchFingerprint({ agent: 'codex', target })).toBe(
        canonicalAgentSessionDigest({ method: 'agent.launch', agent: 'codex', target })
      )
    }
  )
})
