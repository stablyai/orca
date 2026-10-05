// @vitest-environment happy-dom
// A paired host's conversation field can supply the picker's model beside or instead of a status.
// Only new model evidence may undo a user's pick: switching between an unchanged field and a
// status is never a report, while a changed field report always is.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { TerminalConversationIdentity } from '../../../../shared/terminal-conversation-identity'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'

const MODELS: CatalogModel[] = [
  'old/P',
  'new/Q',
  'user/R',
  'next/Q2',
  'other/P2',
  'rollback/V'
].map((id) => ({ id, label: id, options: [] }))

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'field-host', runtime: null }),
  discoverNativeChatCatalogModels: async () => MODELS
}))

type StoreState = {
  settings: Record<string, unknown>
  updateSettings: () => Promise<undefined>
  agentStatusByPaneKey: Record<string, unknown>
  tabsByWorktree: Record<string, unknown[]>
}

const storeState: StoreState = {
  settings: {},
  updateSettings: async () => undefined,
  agentStatusByPaneKey: {},
  tabsByWorktree: {}
}

vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (state: StoreState) => unknown) => selector(storeState), {
    getState: () => storeState
  })
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

const LEAF = '11111111-1111-4111-8111-111111111111'
const S = { key: 'session_id' as const, id: 'S', transcriptPath: '/r/S.jsonl' }
let sequence = 0

function field(
  model: string,
  overrides: Partial<TerminalConversationIdentity> = {}
): TerminalConversationIdentity {
  return {
    agentType: 'omp',
    providerSession: S,
    model,
    modelSwitchCommand: 'orca-model',
    capturedAt: 100,
    source: 'live',
    ...overrides
  }
}

type Frame = {
  status?: string
  /** Omitted: an old host, or a host that publishes no conversation for the pane. */
  field?: TerminalConversationIdentity
}

async function mountPicker() {
  sequence += 1
  const tabId = `tab-field-${sequence}`
  const paneKey = `${tabId}:${LEAF}`
  const dispatchCommand = vi.fn<NativeChatSessionOptionDispatchCommand>(async () => undefined)
  const show = (frame: Frame): void => {
    storeState.agentStatusByPaneKey = frame.status
      ? {
          [paneKey]: {
            agentType: 'omp',
            providerSession: S,
            model: frame.status,
            modelSwitchCommand: 'orca-model'
          }
        }
      : {}
    storeState.tabsByWorktree =
      frame.field === undefined
        ? {}
        : {
            wt: [
              {
                id: tabId,
                hostConversationByLeafId: {
                  [LEAF]: { identity: frame.field, offeredWithoutStatus: !frame.status }
                }
              }
            ]
          }
  }
  show({})
  const hook = renderHook(() =>
    useNativeChatSessionOptions({
      agent: 'omp',
      terminalTabId: tabId,
      targetPtyId: `pty-field-${sequence}`,
      dispatchCommand,
      paneKey
    })
  )
  const selected = (): string | undefined => {
    const model = hook.result.current.snapshot.find((descriptor) => descriptor.id === 'model')
    return model?.kind.type === 'select' ? model.kind.currentValue : undefined
  }
  await waitFor(() => expect(hook.result.current.surface).not.toBeNull())
  return {
    dispatchCommand,
    selected,
    deliver: async (frame: Frame) => {
      show(frame)
      hook.rerender()
      await act(async () => {
        await Promise.resolve()
      })
    },
    pick: async (model: string) => {
      await act(async () => {
        await hook.result.current.surface!.setOption('model', model)
      })
      await waitFor(() => expect(selected()).toBe(model))
    }
  }
}

beforeEach(() => {
  clearNativeChatModelEnrichmentForTests()
  storeState.agentStatusByPaneKey = {}
  storeState.tabsByWorktree = {}
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})

describe('picker model from the conversation field', () => {
  it('keeps a pick across a no-evidence frame when the unchanged field returns', async () => {
    const picker = await mountPicker()
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    expect(picker.selected()).toBe('new/Q')
    await picker.pick('user/R')
    await picker.deliver({})
    await picker.deliver({ field: field('old/P') })
    expect(picker.selected()).toBe('user/R')
  })

  it('applies a field model that changed while it was unusable', async () => {
    const picker = await mountPicker()
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    await picker.pick('user/R')
    await picker.deliver({})
    await picker.deliver({ field: field('other/P2') })
    expect(picker.selected()).toBe('other/P2')
  })

  it('keeps a pick when the field goes absent and the same report returns', async () => {
    const picker = await mountPicker()
    await picker.deliver({ field: field('old/P') })
    await picker.pick('user/R')
    await picker.deliver({})
    await picker.deliver({ field: field('old/P') })
    expect(picker.selected()).toBe('user/R')
  })

  it('keeps a pick when a status goes away and comes back over an unchanged field', async () => {
    const picker = await mountPicker()
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    expect(picker.selected()).toBe('new/Q')
    await picker.pick('user/R')
    await picker.deliver({ field: field('old/P') })
    expect(picker.selected()).toBe('user/R')
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    expect(picker.selected()).toBe('user/R')
    expect(picker.dispatchCommand).toHaveBeenCalledTimes(1)
    expect(picker.dispatchCommand).toHaveBeenCalledWith('/orca-model user/R')
  })

  it('takes a genuinely new status report after a pick', async () => {
    const picker = await mountPicker()
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    await picker.pick('user/R')
    await picker.deliver({ status: 'next/Q2', field: field('old/P') })
    expect(picker.selected()).toBe('next/Q2')
  })

  it('reseeds when the pane moves to another conversation', async () => {
    const picker = await mountPicker()
    await picker.deliver({ field: field('old/P') })
    await picker.pick('user/R')
    await picker.deliver({
      field: field('other/P2', { providerSession: { key: 'session_id', id: 'T' } })
    })
    expect(picker.selected()).toBe('other/P2')
  })

  it('seeds a cold picker from the field, then keeps a later status choice', async () => {
    const picker = await mountPicker()
    await picker.deliver({ field: field('old/P') })
    expect(picker.selected()).toBe('old/P')
    await picker.deliver({ status: 'new/Q', field: field('old/P') })
    expect(picker.selected()).toBe('new/Q')
    await picker.deliver({ field: field('old/P') })
    expect(picker.selected()).toBe('new/Q')
  })

  it('identifies a field report by its whole tuple, not its clock alone', async () => {
    const picker = await mountPicker()
    await picker.deliver({ field: field('old/P', { capturedAt: 100 }) })
    await picker.deliver({ field: field('new/Q', { capturedAt: 100 }) })
    expect(picker.selected()).toBe('new/Q')
    await picker.deliver({ field: field('old/P', { capturedAt: 101 }) })
    await picker.pick('user/R')
    await picker.deliver({ field: field('old/P', { capturedAt: 101 }) })
    expect(picker.selected()).toBe('user/R')
    await picker.deliver({ field: field('rollback/V', { capturedAt: 90 }) })
    expect(picker.selected()).toBe('rollback/V')
  })
})
