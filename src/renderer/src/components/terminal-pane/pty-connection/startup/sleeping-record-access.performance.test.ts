import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { installSleepingRecordAccess } from './sleeping-record-access'

const LEAF = '11111111-1111-4111-8111-111111111111'
let reads = 0

/** A record that counts every field read of it, by the cleanup and by index maintenance alike. */
function countedRecord(
  paneKey: string,
  conversation: string,
  capturedAt: number
): SleepingAgentSessionRecord {
  const fields: SleepingAgentSessionRecord = {
    paneKey,
    worktreeId: 'wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: conversation },
    prompt: '',
    state: 'done',
    capturedAt,
    updatedAt: capturedAt
  }
  const counted = { ...fields }
  for (const [field, value] of Object.entries(fields)) {
    Object.defineProperty(counted, field, {
      enumerable: true,
      get() {
        reads += 1
        return value
      }
    })
  }
  return counted
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1_000])(
  'cleanup after each of %i targeted resumes reads only its own conversation, not the workspace',
  (count) => {
    const records: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < count; index++) {
      const paneKey = `tab-${index}:${LEAF}`
      records[paneKey] = countedRecord(paneKey, `conversation-${index}`, 10)
    }
    // An older pane naming target 0's conversation is a real duplicate and must go.
    records[`alias:${LEAF}`] = countedRecord(`alias:${LEAF}`, 'conversation-0', 5)
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: records })
    sleepingAgentRecordIndex.entries(useAppStore.getState().sleepingAgentSessionsByPaneKey, 'wt')
    reads = 0

    for (let index = 0; index < count; index++) {
      const paneKey = `tab-${index}:${LEAF}`
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: install reads only these fields when the pane has no startup.
      const session = {
        cacheKey: paneKey,
        deps: { worktreeId: 'wt', tabId: `tab-${index}` },
        pane: { id: 1, leafId: LEAF },
        paneStartup: undefined
      } as unknown as ConnectPanePtySession
      installSleepingRecordAccess(session)
      session.clearSleepingRecordProviderDuplicates(
        useAppStore.getState(),
        { paneKey, record: records[paneKey] },
        paneKey
      )
    }

    const remaining = useAppStore.getState().sleepingAgentSessionsByPaneKey
    expect(remaining[`alias:${LEAF}`]).toBeUndefined()
    expect(Object.keys(remaining)).toHaveLength(count)
    expect(reads).toBeLessThanOrEqual(40 * count)
  }
)
