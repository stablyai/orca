import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT } from '../../../../shared/agent-status/presentation/agent-tab-title'
import { getDefaultSettings } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

/** Every `layout.apply` command the window sent, whichever the transport below answers. */
const sentCommands = vi.hoisted((): unknown[] => [])

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
      const [, method, params] = args
      if (
        method === 'layout.apply' &&
        typeof params === 'object' &&
        params &&
        'command' in params
      ) {
        sentCommands.push(params.command)
      }
      return client.callRuntimeRpc(...args)
    }
  }
})

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function seedWorktree(store: ReturnType<typeof createTestStore>, enabled: boolean): string {
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: enabled
    },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

/** The title the window gives the tab: a layout-owner build's main derives it (its twin in
 *  agent-generated-tab-titles.test.ts), so the window writes none until main's frame. */
const windowGives = (title: string): string | undefined =>
  ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : title

describe('generated agent tab titles', () => {
  beforeEach(() => {
    sentCommands.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    // Neither build sends main a generated title: the window keeps its own, main derives its own.
    expect(sentCommands).not.toContainEqual(expect.objectContaining({ type: 'renameTabs' }))
  })

  it('does not trim the full paste-sized prompt before generating an optional title', async () => {
    vi.useFakeTimers()
    const trimSpy = vi.spyOn(String.prototype, 'trim')
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const prompt = `Fix the flaky status tests ${'large pasted text '.repeat(5000)}`

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe(windowGives('Fix the flaky status tests large pasted'))
    expect(
      trimSpy.mock.contexts.some(
        (context) => String(context).length > GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
      )
    ).toBe(false)
  })
})
