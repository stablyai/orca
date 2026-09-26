import { describe, expect, it, vi } from 'vitest'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import { claudePinnedLaunchError } from '../../../../shared/claude/claude-pinned-launch-error'
import type { PtyPaneStartup } from './pty-connection-types'
import {
  recordRefusedClaudeLaunchStartup,
  redirectsPtylessPaneActivation,
  replayRefusedClaudeLaunch,
  startRefusedPaneOnActiveClaudeAccount
} from './refused-claude-launch-recovery'

const refusal = claudePinnedLaunchError('host-sessions', 'Account in use.').message

const resumedStartup: NonNullable<PtyPaneStartup> = {
  command: 'claude --resume s-1',
  launchAgent: 'claude',
  draftPrompt: 'keep going',
  resumeProviderSession: { key: 'session_id', id: 's-1' },
  launchConfig: { agentArgs: '--verbose', agentEnv: {}, claudeAccountId: 'acct-b' },
  telemetry: { agent_kind: 'claude-code', launch_source: 'sidebar', request_kind: 'resume' }
}

describe('Start on active account after a refused pinned launch', () => {
  it('replays the refused spawn in its own pane on the active account', () => {
    const refusedStartups = new Map<number, NonNullable<PtyPaneStartup>>()
    recordRefusedClaudeLaunchStartup(refusedStartups, 2, refusal, resumedStartup)
    const restartPane = vi.fn()
    const openNewTab = vi.fn()

    startRefusedPaneOnActiveClaudeAccount({ paneId: 2, refusedStartups, restartPane, openNewTab })

    expect(restartPane).toHaveBeenCalledWith(2, {
      ...resumedStartup,
      launchConfig: { ...resumedStartup.launchConfig, claudeAccountId: ACTIVE_CLAUDE_ACCOUNT }
    })
    expect(openNewTab).not.toHaveBeenCalled()
    expect(refusedStartups.size).toBe(0)
  })

  it('ignores errors that are not pinned-account refusals', () => {
    const refusedStartups = new Map<number, NonNullable<PtyPaneStartup>>()
    recordRefusedClaudeLaunchStartup(refusedStartups, 2, 'spawn failed', resumedStartup)
    recordRefusedClaudeLaunchStartup(refusedStartups, 3, refusal, undefined)

    expect(refusedStartups.size).toBe(0)
  })

  it('opens a new tab, leaving the old one alone, when no refused spawn was recorded', () => {
    const restartPane = vi.fn()
    const openNewTab = vi.fn()

    startRefusedPaneOnActiveClaudeAccount({
      paneId: 2,
      refusedStartups: new Map(),
      restartPane,
      openNewTab
    })

    expect(openNewTab).toHaveBeenCalledTimes(1)
    expect(restartPane).not.toHaveBeenCalled()
  })

  it('retries the refused spawn unchanged in its own pane', () => {
    const refusedStartups = new Map([[2, resumedStartup]])
    const restartPane = vi.fn()

    expect(
      replayRefusedClaudeLaunch({ paneId: 2, refusedStartups, restartPane, onActiveAccount: false })
    ).toBe(true)
    expect(restartPane).toHaveBeenCalledWith(2, resumedStartup)
  })
})

describe('activating a refused pane in a split tab', () => {
  const ptyIdsByLeafId = { 'leaf-sibling': 'pty-sibling' }

  it('keeps a refused pane activatable so its recovery toast can show', () => {
    const refusedStartups = new Map<number, NonNullable<PtyPaneStartup>>()
    recordRefusedClaudeLaunchStartup(refusedStartups, 1, refusal, resumedStartup)
    expect(
      redirectsPtylessPaneActivation({
        ptyIdsByLeafId,
        leafId: 'leaf-refused',
        paneId: 1,
        refusedStartups
      })
    ).toBe(false)
  })

  it('still redirects other PTY-less panes to a live sibling', () => {
    expect(
      redirectsPtylessPaneActivation({
        ptyIdsByLeafId,
        leafId: 'leaf-empty',
        paneId: 1,
        refusedStartups: new Map()
      })
    ).toBe(true)
  })
})
