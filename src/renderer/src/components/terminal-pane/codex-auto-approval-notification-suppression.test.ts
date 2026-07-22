import { beforeEach, describe, expect, it, vi } from 'vitest'
import { YOLO_TUI_AGENT_ARGS } from '../../../../shared/tui-agent-permissions'
import { createTestStore, makeTab } from '../../store/slices/store-test-helpers'
import type { AppState } from '../../store/types'
import {
  createCodexAutoApprovalHookCompletionSuppressor,
  shouldSuppressCodexAutoApprovalSyntheticTitle,
  shouldSuppressCodexAutoApprovalStatus
} from './codex-auto-approval-notification-suppression'

let testStore: ReturnType<typeof createTestStore>

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testStore.getState()
  }
}))

const paneKey = 'tab-1:leaf-1'
const launchToken = 'launch-token-1'
const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }

function seedTab(): void {
  testStore.setState({
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    }
  } as Partial<AppState>)
}

function registerCodexLaunchConfig(args: {
  agentArgs: string
  launchToken?: string
  providerSession?: typeof providerSession
}): void {
  testStore.getState().registerAgentLaunchConfig(
    paneKey,
    {
      agentArgs: args.agentArgs,
      agentEnv: {}
    },
    {
      agentType: 'codex',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ...(args.launchToken ? { launchToken: args.launchToken } : {}),
      ...(args.providerSession ? { providerSession: args.providerSession } : {})
    }
  )
}

describe('Codex auto-approval status suppression', () => {
  beforeEach(() => {
    testStore = createTestStore()
    seedTab()
  })

  it('suppresses the first auto-approved Codex waiting status with matching launch token', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(true)
  })

  it('suppresses auto-approved Codex blocked statuses', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'blocked', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(true)
  })

  it('preserves request_user_input question waits even under yolo attribution', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        {
          state: 'waiting',
          prompt: 'pick a color',
          agentType: 'codex',
          toolName: 'request_user_input'
        },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
  })

  it('preserves manual Codex permission attention', () => {
    registerCodexLaunchConfig({ agentArgs: '', launchToken })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
  })

  it('preserves mixed Codex permission attention', () => {
    registerCodexLaunchConfig({ agentArgs: '--ask-for-approval on-request', launchToken })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
  })

  it('preserves missing-attribution Codex permission attention', () => {
    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
  })

  it('fails open when a stale yolo launch token does not match', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'manual prompt', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken: 'manual-launch' }
      )
    ).toBe(false)
  })

  it('fails open when a stale launch token conflicts with matching provider session', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken,
      providerSession
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'manual prompt', agentType: 'codex' },
        {
          paneKey,
          tabId: 'tab-1',
          launchToken: 'manual-launch',
          providerSession
        }
      )
    ).toBe(false)
  })

  it('fails open when launch token is missing from a token-registered launch', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken,
      providerSession
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'manual prompt', agentType: 'codex' },
        {
          paneKey,
          tabId: 'tab-1',
          providerSession
        }
      )
    ).toBe(false)
  })

  it('matches provider session attribution when launch token is absent', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      providerSession
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', providerSession }
      )
    ).toBe(true)
  })

  it('does not suppress non-Codex or done statuses', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'waiting', prompt: 'implement notifications', agentType: 'claude' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
    expect(
      shouldSuppressCodexAutoApprovalStatus(
        { state: 'done', prompt: 'implement notifications', agentType: 'codex' },
        { paneKey, tabId: 'tab-1', launchToken }
      )
    ).toBe(false)
  })

  it('uses the same predicate for hook-completion fallback suppression', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })
    const suppressor = createCodexAutoApprovalHookCompletionSuppressor(paneKey, () => ({
      tabId: 'tab-1',
      launchToken
    }))

    expect(
      suppressor({ state: 'waiting', prompt: 'implement notifications', agentType: 'codex' })
    ).toBe(true)
  })

  it('suppresses synthetic Codex permission titles only when launch attribution is yolo', () => {
    registerCodexLaunchConfig({
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      launchToken
    })

    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitle('Codex - action required', {
        paneKey,
        tabId: 'tab-1',
        launchToken
      })
    ).toBe(true)
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitle('Codex ready', {
        paneKey,
        tabId: 'tab-1',
        launchToken
      })
    ).toBe(false)
  })
})
