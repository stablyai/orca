import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { structuredAgentSessionWorkingAtStop } from '../../../src/main/native-chat/agent-session-wire/termination/structured-agent-session-working-at-teardown'
import {
  NOW,
  record,
  SESSION,
  TEARDOWN_CURRENT,
  THREAD
} from '../../../src/main/native-chat/agent-session-wire/recovery/testing/structured-agent-session-restart-resume.test-fixture'
import { AgentSessionRecoveryCapsule } from '../../../src/main/runtime/agent-session/records/agent-session-recovery-capsule'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import { prepareReleaseFixtures } from './release-fixture-setup'

// A release whose marker parser still requires the chat's newest message id.
const BASELINE_REF = 'v1.4.211'
const releaseCapsule = prepareReleaseFixtures([BASELINE_REF], async (ref) =>
  importReleaseCheckoutModule(
    await materializeReleaseCheckout(ref),
    'src/main/runtime/agent-session-recovery-capsule.ts'
  )
)

test('an older build reads the restart offer this build records at quit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-resume-marker-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: the offer teardown takes for a chat whose turn was running.
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: directory,
      now: () => NOW
    })
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: NOW },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const marker = await structuredAgentSessionWorkingAtStop({
      sessionId: SESSION,
      session: { journal, child: { fence: 1, phase: 'ready' } },
      getRecord: () => record(),
      childWork: () => undefined,
      childWorkOpen: () => false,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })
    if (!marker) {
      throw new Error('this build recorded no offer for a running turn')
    }
    await new AgentSessionRecoveryCapsule(directory).record([marker], NOW)

    // The older build, after a downgrade, still lists it.
    const baseline = releaseCapsule(BASELINE_REF)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release exports this class with the constructor and `list` called below; a missing one fails the test.
    const OldCapsule = baseline.AgentSessionRecoveryCapsule as new (directory: string) => {
      list: (now: number) => Promise<{ sessionId: string }[]>
    }
    expect(await new OldCapsule(directory).list(NOW)).toMatchObject([{ sessionId: SESSION }])
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})
