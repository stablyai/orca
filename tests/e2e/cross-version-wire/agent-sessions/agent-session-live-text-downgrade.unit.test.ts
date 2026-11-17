import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../src/shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { createTrackedJournalOpener } from '../../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { readTestJournalItems } from '../../../../src/main/native-chat/agent-session-journal/journal-observation.test-support'
import { codexProviderHandle } from '../../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AgentSessionSubscribers } from '../../../../src/main/native-chat/agent-session-wire/publication/subscribers/structured-agent-session-subscribers'
import { createAgentSessionTextAppendReader } from '../../../../src/shared/agent-session/view/live-read/agent-session-text-append'
import { noteAgentSessionTextAppendSource } from '../../../../src/shared/agent-session/view/live-read/agent-session-text-append-source'
import { structuredHostStub, installableHost } from './structured-agent-session-host-fixture'
import { callBuild } from './structured-agent-session-surface-execution'
import { loadAgentSessionWireBuild, WORKING_TREE } from './versioned-agent-session-wire'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport
} from '../release-checkouts/release-checkout'
import { prepareReleaseFixtures } from '../release-checkouts/release-fixture-setup'
import type * as Reducer from '../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'

const releases = ['v1.4.200', 'mobile-android-v0.0.64']
const clientModules = prepareReleaseFixtures(releases, async (ref) => {
  const checkout = await materializeReleaseCheckout(ref)
  return importReleaseCheckoutModule(checkout, '/src/shared/structured-agent-session-reducer.ts')
})

// Exercise the registered RPC method and publisher, not a hand-written fallback encoder.
test.each([
  { label: 'older desktop', kind: 'runtime' as const, release: releases[0]!, append: false },
  { label: 'older phone', kind: 'mobile' as const, release: releases[1]!, append: false },
  { label: 'current desktop', kind: 'runtime' as const, release: null, append: true },
  { label: 'current phone', kind: 'mobile' as const, release: null, append: true }
])(
  '$label receives exact live text at an unchanged durable cursor',
  async ({ kind, release, append }) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-live-text-wire-'))
    const journals = createTrackedJournalOpener()
    let close = () => {}
    try {
      const build = await loadAgentSessionWireBuild(WORKING_TREE)
      const client = release
        ? clientModules(release)
        : await import('../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer')
      const reduce = releaseModuleExport<typeof Reducer.reduceStructuredAgentSession>(
        client,
        'reduceStructuredAgentSession'
      )
      let state = releaseModuleExport<typeof Reducer.EMPTY_STRUCTURED_AGENT_SESSION>(
        client,
        'EMPTY_STRUCTURED_AGENT_SESSION'
      )
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: codexProviderHandle('thread-1')
        },
        stateDirectory: directory
      })
      await journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'hello' }]
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      const [saved] = await readTestJournalItems(journal)
      const identity = {}
      const liveRow = (text: string): AgentJournalRenderItem => {
        const item = {
          ...saved!,
          body: {
            kind: 'message' as const,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text }]
          }
        }
        noteAgentSessionTextAppendSource(item, {
          identity,
          length: text.length,
          suffix: (from) => text.slice(from)
        })
        return item
      }
      let live = [liveRow('hello')]
      const subscribers = new AgentSessionSubscribers({ readLiveText: () => live })
      const host = installableHost(structuredHostStub('session-1', 'workspace-1'))
      vi.spyOn(host, 'subscribe').mockImplementation(async (input) => {
        close = subscribers.open({ ...input, journal, fence: 1 })
        return close
      })
      await build.installStructuredHost(host)
      let delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
      const wire: AgentSessionSubscribeEvent[] = []
      const reader = append
        ? createAgentSessionTextAppendReader({})
        : (event: AgentSessionSubscribeEvent) => event
      await callBuild<AgentSessionSubscribeEvent>(
        build,
        'agentSession.subscribe',
        {
          sessionId: 'session-1',
          ...(append ? { capabilities: { textAppend: 1 } } : {})
        },
        { clientKind: kind, clientCapabilities: build.capabilities },
        undefined,
        (reply) => {
          if (reply.result) {
            wire.push(reply.result)
            const event = reader(reply.result)
            if (event) {
              state = reduce(state, { type: 'event', event })
            }
            delivered.resolve(reply.result)
          }
        }
      )
      await delivered.promise
      expect(state.items[0]?.body).toMatchObject({ blocks: [{ text: 'hello' }] })
      const cursor = journal.cursor()
      for (const text of ['hello world', 'hello world!']) {
        delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
        live = [liveRow(text)]
        subscribers.publishLiveText('session-1', journal, 1, () => live)
        const event = await delivered.promise
        expect(event.type).toBe('batch')
        expect(state.items[0]?.body).toMatchObject({ blocks: [{ text }] })
        expect(journal.cursor()).toEqual(cursor)
        if (event.type === 'batch') {
          if (append) {
            expect(event.batch.items[0]).toHaveProperty('textAppend')
          } else {
            expect(event.batch.items[0]).not.toHaveProperty('textAppend')
          }
        }
      }
      expect(wire).toHaveLength(3)
      // Reopening the stream resets append bases and carries current live text whole.
      close()
      delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
      subscribers.open({
        id: 'reopen',
        sessionId: 'session-1',
        journal,
        fence: 1,
        emit: (event) => delivered.resolve(event)
      })
      const reopened = await delivered.promise
      expect(reopened.type).toBe('snapshot')
      if (reopened.type === 'snapshot') {
        expect(reopened.page.items[0]?.body).toMatchObject({ blocks: [{ text: 'hello world!' }] })
      }
      subscribers.close('session-1', 'reopen')
    } finally {
      close()
      await journals.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  },
  180_000
)
