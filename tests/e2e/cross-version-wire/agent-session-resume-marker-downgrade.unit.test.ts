import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { structuredAgentSessionWorkingAtStop } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-working-at-teardown'
import {
  journal,
  NOW,
  record,
  SESSION,
  TEARDOWN_CURRENT,
  turnItem
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { AgentSessionRecoveryCapsule } from '../../../src/main/runtime/agent-session-recovery-capsule'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A release whose marker parser still requires the chat's newest message id.
const BASELINE_REF = 'v1.4.211'

test('an older build reads the restart offer this build records, continuations and all', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-resume-marker-downgrade-'))
  try {
    // This build: the offer teardown takes for a chat whose turn was running.
    const marker = structuredAgentSessionWorkingAtStop({
      sessionId: SESSION,
      session: { journal: journal([turnItem('turn-1', 'running')]), child: { fence: 1 } },
      getRecord: () => record(),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })
    if (!marker) {
      throw new Error('this build recorded no offer for a running turn')
    }
    const capsule = new AgentSessionRecoveryCapsule(directory)
    await capsule.record([marker], NOW)
    // A resume action that did not finish leaves its continuation recorded on the offer.
    await capsule.beginResume([SESSION], 'operation-1', NOW, () => 'continuation-1')
    await capsule.rollbackResume('operation-1', NOW)
    expect(await capsule.list(NOW)).toMatchObject([{ continuations: ['continuation-1'] }])

    // The older build, after a downgrade, still lists it.
    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const baseline = await importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/agent-session-recovery-capsule.ts'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release exports this class with the constructor and `list` called below; a missing one fails the test.
    const OldCapsule = baseline.AgentSessionRecoveryCapsule as new (directory: string) => {
      list: (now: number) => Promise<{ sessionId: string }[]>
    }
    expect(await new OldCapsule(directory).list(NOW)).toMatchObject([{ sessionId: SESSION }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
