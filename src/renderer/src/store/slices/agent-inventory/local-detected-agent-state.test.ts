import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { localAgentInventoryContextKey } from '@/runtime/hosts/preflight/local-preflight-context-key'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

const COMPLETE_INVENTORY = localAgentInventoryContextKey(undefined, true)
const settingsWith = (disabledTuiAgents: TuiAgent[]) =>
  createGlobalSettingsFixture({ disabledTuiAgents })

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("this computer's agent inventory", () => {
  // Settings reads the complete inventory, which the disabled list does not filter: a toggle must not
  // blank it. A probe that ran against the old disabled list must not land in the enabled one.
  it('keeps the complete inventory and discards a stale enabled probe when the disabled list changes', async () => {
    let answerStaleProbe: (ids: string[]) => void = () => {}
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectAgents: () =>
            new Promise<string[]>((resolve) => {
              answerStaleProbe = resolve
            })
        }
      }
    })
    useAppStore.setState({
      settings: settingsWith([]),
      localDetectedAgentIdsByContext: { [COMPLETE_INVENTORY]: ['claude', 'codex'] }
    })
    const staleProbe = useAppStore.getState().ensureDetectedAgents()

    useAppStore.setState({ settings: settingsWith(['codex']) })
    answerStaleProbe(['claude', 'codex'])
    await staleProbe

    expect(useAppStore.getState().localDetectedAgentIdsByContext).toEqual({
      [COMPLETE_INVENTORY]: ['claude', 'codex']
    })
  })

  // The dropped enabled list is not the refresh's to fill: a failure must not cache it as a usable [].
  it('leaves the enabled inventory to be re-probed when a complete refresh spanning a toggle fails', async () => {
    let failRefresh: (error: Error) => void = () => {}
    const detectAgents = vi.fn(async () => ['claude'])
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectAgents,
          refreshAgents: () =>
            new Promise((_resolve, reject) => {
              failRefresh = reject
            })
        }
      }
    })
    useAppStore.setState({
      settings: settingsWith([]),
      localDetectedAgentIdsByContext: {
        [COMPLETE_INVENTORY]: ['claude', 'codex'],
        host: ['claude', 'codex']
      }
    })
    const refresh = useAppStore.getState().refreshAllDetectedAgents()

    useAppStore.setState({ settings: settingsWith(['codex']) })
    failRefresh(new Error('PATH probe failed'))
    await refresh

    expect(useAppStore.getState().localDetectedAgentIdsByContext).toEqual({
      [COMPLETE_INVENTORY]: ['claude', 'codex']
    })
    await expect(useAppStore.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(1)
  })

  // After the toggle a newer enabled refresh owns the legacy fields; the older complete one must not end its spinner.
  it('leaves the legacy refresh state to a newer enabled refresh when a complete refresh spans a toggle', async () => {
    const answers: ((result: { agents: string[]; pathSource: string }) => void)[] = []
    vi.stubGlobal('window', {
      api: {
        preflight: {
          refreshAgents: () =>
            new Promise((resolve) => {
              answers.push(resolve)
            })
        }
      }
    })
    useAppStore.setState({ settings: settingsWith([]) })
    const completeRefresh = useAppStore.getState().refreshAllDetectedAgents()

    useAppStore.setState({ settings: settingsWith(['codex']) })
    void useAppStore.getState().refreshDetectedAgents()
    answers[0]({ agents: ['claude', 'codex'], pathSource: 'shell_hydrate' })
    await completeRefresh

    expect(useAppStore.getState()).toMatchObject({
      detectedAgentIds: null,
      isRefreshingAgents: true
    })
  })
})
