/**
 * Which launch inputs the replay digest covers, and — just as deliberately — which it does not.
 *
 * The digest decides whether a retry replays the first answer or is refused as a different call
 * wearing the same id, so every field added to the launch wire is a decision in one of two
 * directions. Both directions are pinned here: a behavioural field that fell OUT would let a retry
 * carrying different arguments silently inherit the original's outcome, and a telemetry field that
 * crept IN would refuse an honest retry that merely got re-attributed.
 */

import { describe, expect, it } from 'vitest'
import {
  computeAgentLaunchFingerprint,
  deriveAgentLaunchChildOperationId,
  type AgentLaunchFingerprintInput
} from './agent-launch-operation'
import { canonicalAgentSessionDigest } from './agent-session-mutation-envelope'
import { deriveAgentLaunchChildOperationId as browserChildId } from './agent-launch-child-operation'

it('keeps browser and host opening-message identity compatible with existing child receipts', () => {
  const operationId = '1790000000123-0123456789abcdef0123456789abcdef'
  const child = browserChildId(operationId)
  expect(child).toBe('1790000000123-7b6527b99cc98b8e0e80d8829453ad3c')
  expect(deriveAgentLaunchChildOperationId(operationId)).toBe(child)
  expect(child).toBe(
    `1790000000123-${canonicalAgentSessionDigest({ child: 'agent.launch:attach', operationId }).slice(0, 32)}`
  )
  if (!child) {
    throw new Error('valid launch operation must have a child')
  }
  expect(browserChildId(child)).toBe('1790000000123-b4a6aab1c63a7cd37871a6d77772d9e2')
  expect(browserChildId(child)).toBe(
    `1790000000123-${canonicalAgentSessionDigest({ child: 'agent.launch:attach', operationId: child }).slice(0, 32)}`
  )
  expect(browserChildId('invalid-operation')).toBeNull()
})

const BASE = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: 'wt-1' }
}
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:6fa459ea-ee8a-4ca4-894e-db77e160355e'

/**
 * The handler digests the whole params object, `launchSource` included — excess properties are only
 * rejected on an object literal, never on the params value it actually passes. Going through this
 * signature keeps the exclusion tests honest: they prove the digest IGNORES the field at runtime,
 * not merely that the input type has no name for it.
 */
function fingerprintOfWirePayload(
  params: AgentLaunchFingerprintInput & { launchSource?: string }
): string {
  return computeAgentLaunchFingerprint(params)
}

describe('fields the launch fingerprint covers', () => {
  it('separates two launches that differ only in agentArgs', () => {
    expect(computeAgentLaunchFingerprint({ ...BASE, agentArgs: '--model opus' })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, agentArgs: '--model sonnet' })
    )
  })

  it('treats an explicit "no arguments" as different from falling back to the settings default', () => {
    // `null` and absent are the tri-state the wire keeps; collapsing them here would let a retry
    // that cleared its arguments replay an answer produced with the user's configured ones.
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
    // Telemetry. Two buttons producing the same launch are one operation, and a retry that got
    // re-attributed must replay rather than be refused as a conflict.
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
  /**
   * A client that sends none of the new fields must still digest to what the previous build
   * produced, or an upgraded host would refuse the in-flight retries of every launch admitted
   * before it restarted. This is the old expression verbatim rather than a captured constant, so it
   * keeps checking the property rather than a value someone can re-record.
   */
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
