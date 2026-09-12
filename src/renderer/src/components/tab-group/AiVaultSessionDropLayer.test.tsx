// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildDropStartup: vi.fn(),
  getState: vi.fn(),
  launchSession: vi.fn(),
  readDragData: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/ai-vault-resume-target', () => ({
  canResumeAiVaultSessionOnTarget: () => true,
  getAiVaultResumeWorkspaceExecutionHostId: () => 'local',
  getAiVaultResumeWorkspaceTargetStatus: () => 'local'
}))

vi.mock('@/lib/ai-vault-session-drag', () => ({
  AI_VAULT_SESSION_DRAG_END_EVENT: 'orca-ai-vault-session-drag-end',
  AI_VAULT_SESSION_DRAG_START_EVENT: 'orca-ai-vault-session-drag-start',
  clearAiVaultSessionDragData: vi.fn(),
  hasAiVaultSessionDragData: () => true,
  readAiVaultSessionDragData: mocks.readDragData
}))

vi.mock('@/lib/ai-vault-resume-command', () => ({
  getAiVaultAgentProviderSession: () => undefined
}))

vi.mock('@/lib/ai-vault-drop-resume-startup', () => ({
  buildAiVaultDropLaunchStartup: mocks.buildDropStartup
}))

vi.mock('@/lib/launch-ai-vault-session', () => ({
  launchAiVaultSessionInNewTab: mocks.launchSession
}))

vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  aiVaultSessionNeedsResumePreparation: () => false
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn()
}))

vi.mock('./ai-vault-session-drop-target', () => ({
  containsPoint: () => true,
  resolvePaneDropTarget: () => ({ groupId: 'group-1', zone: 'center', overlayStyle: {} })
}))

import AiVaultSessionDropLayer from './AiVaultSessionDropLayer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('AiVaultSessionDropLayer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({})
    mocks.readDragData.mockReturnValue({
      agent: 'codex',
      sessionId: 'session-1',
      title: 'Session',
      command: "cd '/workspace/deleted' && codex resume session-1",
      sessionCwd: '/workspace/deleted',
      sessionExecutionHostId: 'local',
      sessionFilePath: '/tmp/session-1.jsonl',
      codexHome: '/tmp/codex-home'
    })
    mocks.buildDropStartup.mockResolvedValue({ command: 'codex resume session-1' })
    mocks.launchSession.mockReturnValue({ tabId: 'tab-1' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does not launch with the unvalidated payload cwd when startup omits cwd', async () => {
    await act(async () => {
      root.render(<AiVaultSessionDropLayer worktreeId="worktree-1" enabled />)
    })
    const dropEvent = new Event('drop', { cancelable: true })
    Object.defineProperties(dropEvent, {
      clientX: { value: 10 },
      clientY: { value: 10 },
      dataTransfer: { value: {} }
    })

    await act(async () => {
      window.dispatchEvent(dropEvent)
    })
    await vi.waitFor(() => expect(mocks.launchSession).toHaveBeenCalledOnce())

    expect(mocks.launchSession.mock.calls[0][0]).not.toHaveProperty('cwd')
  })
})
