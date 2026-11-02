// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useRef } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { NativeChatComposerProps } from '@/components/native-chat/native-chat-composer-types'
import { NativeChatComposer } from '@/components/native-chat/NativeChatComposer'
import { useNativeChatComposerRevealFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type * as ComposerModule from '@/components/native-chat/NativeChatComposer'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import PendingNativeChatCreation from './PendingNativeChatCreation'
import {
  changePrompt,
  promptEditor,
  promptValue
} from '@/components/native-chat/native-chat-prompt-editor.test-support'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/native-chat-composer-mount'

const composer = vi.hoisted((): { props: NativeChatComposerProps | null } => ({ props: null }))
vi.mock('@/components/native-chat/NativeChatComposer', async (importOriginal) => {
  const original = await importOriginal<typeof ComposerModule>()
  return {
    NativeChatComposer: forwardRef<
      ComposerModule.NativeChatComposerHandle,
      NativeChatComposerProps
    >((props, ref) => {
      composer.props = props
      return <original.NativeChatComposer {...props} ref={ref} />
    })
  }
})
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
  clearNativeChatComposerDraftsForTests()
})

function Destination({
  props,
  ready,
  mounted,
  disabled = false
}: {
  props: NativeChatComposerProps
  ready: boolean
  mounted: boolean
  disabled?: boolean
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerModule.NativeChatComposerHandle>(null)
  useNativeChatComposerRevealFocus({
    tabId: 'destination',
    rootRef,
    composerRef,
    isVisible: false,
    isFocusedGroup: false,
    composerReady: ready
  })
  return (
    <TooltipProvider>
      <div ref={rootRef}>
        {mounted ? (
          <NativeChatComposer
            {...props}
            ref={composerRef}
            terminalTabId="destination"
            paneKey="destination:composer"
            draftScopeKey="destination"
            unavailableHint={disabled ? 'Unavailable' : undefined}
          />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

it.each(['commit', 'blur', 'unmount'])(
  'keeps editable input until a ready replacement and IME %s',
  async (settle) => {
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
    const pending = render(
      <TooltipProvider>
        <PendingNativeChatCreation creationId="creation" />
      </TooltipProvider>
    )
    const field = screen.getByRole('textbox')
    changePrompt(field, 'Half a prompt')
    field.focus()
    const staleTransport = composer.props?.structuredTransport
    expect(staleTransport).toBeDefined()
    expect(composer.props?.unavailableHint).toBeUndefined()
    act(() => {
      useAppStore.getState().updatePendingWorktreeCreation('creation', { chatInputHandedOff: true })
      expect(staleTransport?.send('Too late for the captured plan', [])).toBe(false)
    })
    expect(
      useAppStore.getState().pendingWorktreeCreations.creation?.heldChatMessage
    ).toBeUndefined()
    expect(composer.props?.unavailableHint).toBeUndefined()
    expect(composer.props?.structuredTransport?.sendBlockedReason).toBe('Opening chat…')
    expect(screen.getByRole('textbox')).toBe(field)
    expect(field.getAttribute('contenteditable')).toBe('true')
    expect(document.activeElement).toBe(field)
    act(() => {
      promptEditor(field).commands.insertContent(', still typing')
    })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(promptValue(field)).toBe('Half a prompt, still typing')
    expect(readNativeChatComposerDraft('pending-worktree-creation:creation').text).toBe(
      'Half a prompt, still typing'
    )
    expect(
      useAppStore.getState().pendingWorktreeCreations.creation?.heldChatMessage
    ).toBeUndefined()

    const scope = 'pending-worktree-creation:creation'
    act(() => {
      promptEditor(field).commands.setTextSelection({ from: 6, to: 12 })
    })
    expect(nativeChatComposerSelection(scope)).toEqual({ from: 5, to: 11 })
    fireEvent.compositionStart(field)
    const props = composer.props
    if (!props) {
      throw new Error('Pending composer did not mount')
    }
    const destination = render(<Destination props={props} ready={false} mounted />)
    let replacementReady = false
    const readiness = waitForNativeChatComposerHandoff(
      'no-source',
      'destination',
      new AbortController().signal
    ).then(() => {
      replacementReady = true
    })
    let handedOff = false
    const handoff = waitForNativeChatComposerHandoff(
      scope,
      'destination',
      new AbortController().signal
    ).then(() => {
      handedOff = true
    })
    await act(async () => {})
    expect(handedOff).toBe(false)
    expect(replacementReady).toBe(false)
    destination.rerender(<Destination props={props} ready mounted={false} />)
    await act(async () => {})
    expect(handedOff).toBe(false)
    expect(replacementReady).toBe(false)
    destination.rerender(<Destination props={props} ready mounted disabled />)
    await act(async () => {})
    expect(handedOff).toBe(false)
    expect(replacementReady).toBe(false)
    destination.rerender(<Destination props={props} ready mounted />)
    await act(async () => {})
    expect(handedOff).toBe(false)
    await readiness
    expect(replacementReady).toBe(true)
    if (settle === 'commit') {
      fireEvent.compositionEnd(field)
    } else if (settle === 'blur') {
      fireEvent.blur(field)
    } else {
      pending.unmount()
    }
    await handoff
    destination.unmount()
    expect(handedOff).toBe(true)
  }
)

it('cancels a handoff whose destination never mounts', async () => {
  const abort = new AbortController()
  let completed = false
  const handoff = waitForNativeChatComposerHandoff('no-source', 'missing', abort.signal).then(
    () => {
      completed = true
    }
  )
  await act(async () => {})
  expect(completed).toBe(false)
  abort.abort()
  await handoff
  expect(completed).toBe(true)
})
