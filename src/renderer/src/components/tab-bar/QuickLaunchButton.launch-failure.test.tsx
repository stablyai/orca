// @vitest-environment happy-dom
import {
  mockCreateTab,
  mockToastError,
  store
} from '../../lib/agent-session/launch/new-tab/launch-agent-in-new-tab-test-fixture'
import { expect, it, vi } from 'vitest'
import { launchAgentTabShortcut } from '../agent-tab-shortcut-launch'
import { launchAgentInNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { launchOnceHostAnswered } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-host-agents'

vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  captureNativeChatComposerFocusIntent: () => undefined
}))

function unavailableSsh() {
  store.repos = [{ id: 'repo-1', connectionId: 'missing-host', path: '/repo' }]
}

it('a shortcut while SSH is still connecting waits silently, then settled missing facts refuse once', () => {
  unavailableSsh()
  Object.assign(store, { activeGroupIdByWorktree: {}, groupsByWorktree: {} })
  const sshState = (status: string) =>
    Object.assign(store, { sshConnectionStates: new Map([['missing-host', { status }]]) })
  sshState('connecting')
  launchAgentTabShortcut('wt-1', { agent: 'codex' }, () => true)
  expect(mockToastError).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()

  sshState('disconnected')
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
