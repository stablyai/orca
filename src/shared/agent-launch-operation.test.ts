/** Fingerprint behavioral fields, excluding telemetry: omissions can replay a different launch; extra attribution fields can reject an honest retry. */

import { describe, expect, it } from 'vitest'
import { computeAgentLaunchFingerprint } from './agent-launch-operation'
import { canonicalAgentSessionDigest } from './agent-session/lifecycle/agent-session-mutation-envelope'

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
