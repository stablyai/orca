// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { AgentLaunchPaneNotice } from './AgentLaunchPaneNotice'
import { TerminalErrorToast } from './TerminalErrorToast'
import { agentLaunchPaneOutcomeForLeaf } from './agent-launch-pane-notice-text'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('localized startup failure surfaces', () => {
  it.each([
    {
      language: 'en',
      exit: 'Codex exited while starting. Run it in a terminal in this folder to see why, then try again.',
      workspace:
        "Codex couldn't start because its workspace is no longer available. Restore the workspace folder or open an available workspace, then try again.",
      unknown: "Couldn't confirm Codex started. Check its terminal before trying again."
    },
    {
      language: 'zh',
      exit: 'Codex 在启动时退出了。 请在此文件夹的终端中运行它以查看原因，然后重试。',
      workspace:
        '无法启动 Codex，因为其工作区已不可用。 请恢复工作区文件夹或打开可用的工作区，然后重试。',
      unknown: '无法确认 Codex 已启动。请先检查其终端，再重试。'
    }
  ] as const)('renders both real mappings with the shipped $language catalog', async (copy) => {
    await setRendererUiLanguage(copy.language)
    for (const [code, expected, refusal] of [
      [
        'agent_session_exited_during_start',
        copy.exit,
        { kind: 'not-started', code: 'agent_session_exited_during_start' }
      ],
      ['worktree_not_found', copy.workspace, { kind: 'not-started', code: 'worktree_not_found' }],
      ['agent_session_operation_unknown', copy.unknown, { kind: 'unconfirmed' }]
    ] as const) {
      const toast = render(
        React.createElement(TerminalErrorToast, {
          error: `Error invoking remote method 'pty:spawn': Error: ${code}`,
          agentId: 'codex',
          paneOnClient: false,
          onDismiss: vi.fn()
        })
      )
      const pane = render(
        React.createElement(AgentLaunchPaneNotice, {
          refusal,
          agentId: 'codex',
          tabId: 'localized-startup-failure'
        })
      )
      expect(toast.container.querySelector('span')?.textContent).toBe(expected)
      expect(pane.container.querySelector('span')?.textContent).toBe(expected)
      expect(toast.container.querySelector('a')).toBeNull()
      expect(toast.container.textContent).not.toContain(code)
      expect(pane.container.textContent).not.toContain(code)
      toast.unmount()
      pane.unmount()
    }
  })
})

describe('which pane shows it', () => {
  const outcome = { kind: 'not-started' as const, code: 'boom' }
  const tab = { agentLaunchPane: { leafId: 'leaf-1', outcome } }

  it('the leaf the launch laid out, once its fate is final', () => {
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-1')).toEqual(outcome)
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-2')).toBeNull()
    expect(
      agentLaunchPaneOutcomeForLeaf({ agentLaunchPane: { leafId: 'leaf-1' } }, 'leaf-1')
    ).toBeNull()
    expect(agentLaunchPaneOutcomeForLeaf(undefined, 'leaf-1')).toBeNull()
  })
})
