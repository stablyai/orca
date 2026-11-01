// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { NativeChatComposerProps } from '@/components/native-chat/native-chat-composer-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import PendingNativeChatCreation from './PendingNativeChatCreation'

const composer = vi.hoisted((): { props: NativeChatComposerProps | null } => ({ props: null }))
vi.mock('@/components/native-chat/NativeChatComposer', () => ({
  NativeChatComposer: (props: NativeChatComposerProps) => {
    composer.props = props
    return null
  }
}))
vi.mock('@/components/native-chat/NativeChatEmptyState', () => ({
  NativeChatEmptyState: () => null
}))
vi.mock('@/components/native-chat/NativeChatUserMessageRow', () => ({
  NativeChatUserMessageRow: () => null
}))
vi.mock('./WorktreeSetupSteps', () => ({ WorktreeSetupSteps: () => null }))
vi.mock('./WorktreeCreationTabStrip', () => ({ default: () => null }))

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  composer.props = null
})

it('rejects stale sends once launch owns input and disables the composer until replacement', () => {
  const request: WorktreeCreationRequest = {
    repoId: 'repo',
    name: 'feature',
    setupDecision: 'skip',
    agent: 'codex',
    agentLaunchRoute: 'structured-native-chat',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    suppressTerminalFocusOnCompletion: true
  }
  useAppStore.setState({
    pendingWorktreeCreations: {
      creation: {
        creationId: 'creation',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    }
  })
  render(<PendingNativeChatCreation creationId="creation" />)
  const staleTransport = composer.props?.structuredTransport
  expect(staleTransport).toBeDefined()
  expect(composer.props?.unavailableHint).toBeUndefined()
  act(() => {
    useAppStore.getState().updatePendingWorktreeCreation('creation', { chatInputHandedOff: true })
    expect(staleTransport?.send('Too late for the captured plan', [])).toBe(false)
  })
  expect(useAppStore.getState().pendingWorktreeCreations.creation?.heldChatMessage).toBeUndefined()
  expect(composer.props?.unavailableHint).toBe('Opening chat…')
})
