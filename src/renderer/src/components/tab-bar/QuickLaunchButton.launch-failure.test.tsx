// @vitest-environment happy-dom
import {
  mockCreateTab,
  mockToastError,
  store
} from '../../lib/launch-agent-in-new-tab-test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTabAgentMenuLaunch } from './QuickLaunchButton'
import { launchAgentTabShortcut } from '../agent-tab-shortcut-launch'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { launchOnceHostAnswered } from '@/lib/launch-agent-in-new-tab-host-agents'
import { i18n } from '@/i18n/i18n'
import fr from '@/i18n/locales/fr.json'

vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  captureNativeChatComposerFocusIntent: () => undefined
}))
afterEach(cleanup)

function unavailableSsh() {
  store.repos = [{ id: 'repo-1', connectionId: 'missing-host', path: '/repo' }]
}

it('New Chat reports one actionable named-agent error through the actual launcher, including a translated case', async () => {
  unavailableSsh()
  const focus = vi.fn()
  const handedOff = vi.fn()
  const hook = renderHook(() =>
    useTabAgentMenuLaunch({
      worktreeId: 'wt-1',
      groupId: 'g',
      onFocusTerminal: focus,
      onPromptHandedOff: handedOff
    })
  )
  const previous = i18n.language
  i18n.addResourceBundle('fr', 'translation', fr)
  try {
    for (const language of ['en', 'fr']) {
      await i18n.changeLanguage(language)
      mockToastError.mockClear()
      act(() => hook.result.current({ kind: 'cli', agent: 'codex' }))
      expect(mockToastError).toHaveBeenCalledExactlyOnceWith(
        language === 'fr'
          ? 'Impossible de démarrer une nouvelle session Codex.'
          : 'Could not start a new Codex session.',
        {
          description:
            language === 'fr'
              ? fr.agentLaunch.connectSsh
              : 'Connect to this workspace’s SSH host, then try again.'
        }
      )
    }
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(handedOff).not.toHaveBeenCalled()
  } finally {
    await i18n.changeLanguage(previous)
  }
})

it('a shortcut while SSH is still connecting waits silently, then settled missing facts refuse once', () => {
  unavailableSsh()
  Object.assign(store, { activeGroupIdByWorktree: {}, groupsByWorktree: {} })
  const sshState = (status: string) =>
    new Map([['missing-host', { status }]]) as unknown as typeof store.sshConnectionStates
  store.sshConnectionStates = sshState('connecting')
  launchAgentTabShortcut('wt-1', { agent: 'codex' }, () => true)
  expect(mockToastError).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()

  store.sshConnectionStates = sshState('disconnected')
  launchAgentTabShortcut('wt-1', { agent: 'codex' }, () => true)
  expect(mockToastError).toHaveBeenCalledExactlyOnceWith('Could not start a new Codex session.', {
    description: 'Connect to this workspace’s SSH host, then try again.'
  })
  expect(mockCreateTab).not.toHaveBeenCalled()
})

it('a terminal opened behind a visible chat returns its refusal to that chat instead of a toast', () => {
  unavailableSsh()
  expect(
    launchAgentInNewTab({
      requestId: 'behind-chat',
      agent: 'codex',
      worktreeId: 'wt-1',
      activate: false,
      presentsRefusal: true
    })
  ).toEqual({
    refused: { delivered: false, failureNotified: true },
    recovery: 'Connect to this workspace’s SSH host, then try again.'
  })
  expect(mockToastError).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()
})

it('cancellation is silent and does not create a tab', () => {
  expect(
    launchAgentInNewTab({
      requestId: 'cancel',
      agent: 'codex',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      beforeSurfaceOpen: () => false
    })
  ).toBeNull()
  expect(mockToastError).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()
})

it('a refusal after the host answers carries the same notified failure to delivery and settlement', async () => {
  unavailableSsh()
  let answer = () => {}
  const awaited = new Promise<void>((resolve) => {
    answer = resolve
  })
  const result = launchOnceHostAnswered(
    {
      awaited,
      replan: () =>
        adoptAgentSessionLaunchVerdict({
          requestId: 'delayed',
          route: 'terminal-tui',
          agent: 'codex',
          worktreeId: 'wt-1'
        })
    },
    { requestId: 'delayed', agent: 'codex', worktreeId: 'wt-1', prompt: 'keep this prompt' },
    launchAgentInNewTab
  )
  expect(mockToastError).not.toHaveBeenCalled()
  answer()
  await expect(result?.promptDeliveryResult).resolves.toEqual({
    delivered: false,
    failureNotified: true
  })
  await expect(result?.structuredSettlement).resolves.toEqual({
    kind: 'cancelled',
    sessionId: null
  })
  expect(mockToastError).toHaveBeenCalledOnce()
  expect(mockCreateTab).not.toHaveBeenCalled()
})
