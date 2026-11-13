// @vitest-environment happy-dom
// CHAT-BANNERS: while a cloud launch is held, the chat view gives its composer no target and the
// hint that points at the strip above it (NativeChatResolvedView). The composer then is disabled and
// shows the hint, not a second message.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerFieldProps } from '../native-chat/composer/editor/NativeChatComposerField'

const captured = vi.hoisted(() => {
  const state: { props: NativeChatComposerFieldProps | null } = { props: null }
  return state
})

vi.mock('../native-chat/composer/editor/NativeChatComposerField', () => ({
  NativeChatComposerField: (props: NativeChatComposerFieldProps) => {
    captured.props = props
    return null
  }
}))
vi.mock('../native-chat/composer/controls/NativeChatComposerWorkspace', () => ({
  NativeChatComposerWorkspace: () => null
}))
vi.mock('../native-chat/composer/controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => null
}))
vi.mock('../native-chat/composer/pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../../store/index', () => {
  const state = {
    tabsByWorktree: {},
    worktrees: [],
    repos: [],
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

const { NativeChatComposer } = await import('../native-chat/composer/NativeChatComposer')

afterEach(() => {
  cleanup()
  captured.props = null
})

describe('the chat composer under a held cloud launch', () => {
  it('is disabled and shows the hint that points at the strip', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId={null}
        agent="claude"
        unavailableHint="Set up Claude above to start"
      />
    )
    expect(captured.props?.disabled).toBe(true)
    expect(captured.props?.unavailableHint).toBe('Set up Claude above to start')
  })

  it('without a hold it takes input as before', () => {
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:leaf-1"
        targetPtyId="pty-1"
        agent="claude"
      />
    )
    expect(captured.props?.disabled).toBe(false)
    expect(captured.props?.unavailableHint).toBeUndefined()
  })
})
