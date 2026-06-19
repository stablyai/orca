import { describe, expect, it } from 'vitest'
import { Globe, Settings } from 'lucide-react'
import type { CmdJQuickAction } from './quick-actions'
import {
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  rankCmdJMiddleResults
} from './palette-results'
import { buildCmdJShortcutResults } from './shortcut-results'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import type { KeybindingDefinition } from '../../../../shared/keybindings'
import { groupDefinitions } from '@/components/settings/shortcut-groups'

const noopRun: CmdJQuickAction['run'] = async () => ({ status: 'ok' })
const available: CmdJQuickAction['isAvailable'] = () => ({ available: true })

const actions: CmdJQuickAction[] = [
  {
    id: 'new-browser-tab',
    kind: 'action',
    title: 'New Browser Tab',
    description: 'Open a browser tab.',
    icon: Globe,
    verbKeywords: ['new browser', 'new browser tab'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'new-terminal-tab',
    kind: 'action',
    title: 'New Terminal Tab',
    description: 'Open a terminal tab.',
    icon: Globe,
    verbKeywords: ['new terminal', 'new terminal tab'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'new-markdown-file',
    kind: 'action',
    title: 'New Markdown File',
    description: 'Create markdown.',
    icon: Globe,
    verbKeywords: ['new markdown', 'new mark'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'create-workspace',
    kind: 'action',
    title: 'Create Worktree',
    description: 'Create worktree.',
    icon: Globe,
    verbKeywords: ['create worktree', 'add worktree', 'new worktree'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'delete-workspace',
    kind: 'action',
    title: 'Delete Worktree',
    description: 'Delete the current worktree.',
    icon: Globe,
    verbKeywords: ['delete worktree', 'delete current worktree', 'remove worktree'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'add-quick-command',
    kind: 'action',
    title: 'Add Quick Command',
    description: 'Create a saved terminal command.',
    icon: Globe,
    verbKeywords: ['add quick command', 'new quick command'],
    isAvailable: available,
    run: noopRun
  }
]

const sections: SettingsNavSection[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Workspace defaults.',
    icon: Settings,
    searchEntries: [
      {
        title: 'Orca CLI',
        description: 'Register or remove the orca shell command.',
        keywords: ['cli', 'path', 'terminal', 'command', 'shell command'],
        cmdJKeywords: ['cli', 'path', 'command', 'shell command'],
        targetSectionId: 'cli'
      }
    ],
    group: 'setup'
  },
  {
    id: 'terminal',
    title: 'Terminal',
    description: 'Shell configuration.',
    icon: Settings,
    searchEntries: [{ title: 'Terminal Font' }],
    group: 'workflows'
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'Cookie import setup.',
    icon: Settings,
    searchEntries: [{ title: 'Default Browser URL' }],
    group: 'workflows'
  },
  {
    id: 'servers',
    title: 'Remote Orca Servers',
    description: 'Pair remote Orca runtimes.',
    icon: Settings,
    searchEntries: [{ title: 'Remote Orca Servers' }],
    group: 'remote'
  },
  {
    id: 'ssh',
    title: 'SSH Hosts',
    description: 'Remote hosts over SSH.',
    icon: Settings,
    searchEntries: [{ title: 'SSH Connections' }],
    group: 'remote'
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme and chrome.',
    icon: Settings,
    searchEntries: [{ title: 'Theme' }],
    group: 'interface'
  },
  {
    id: 'shortcuts',
    title: 'Shortcuts',
    description: 'Keyboard shortcuts.',
    icon: Settings,
    searchEntries: [{ title: 'Keyboard Shortcuts' }],
    group: 'interface'
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Manage AI agents.',
    icon: Settings,
    searchEntries: [{ title: 'Default Agent' }],
    group: 'setup'
  },
  {
    id: 'quick-commands',
    title: 'Quick Commands',
    description: 'Saved commands.',
    icon: Settings,
    searchEntries: [{ title: 'Command Scope' }],
    group: 'workflows'
  }
]

const shortcutDefinitions: KeybindingDefinition[] = [
  {
    id: 'terminal.splitRight',
    title: 'Split terminal right',
    group: 'Terminal',
    scope: 'terminal',
    searchKeywords: ['pane', 'split', 'right'],
    defaultBindings: {
      darwin: ['Mod+Backslash'],
      linux: ['Mod+Shift+Backslash'],
      win32: ['Mod+Shift+Backslash']
    }
  },
  {
    id: 'tab.newTerminal',
    title: 'New Terminal',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['terminal', 'tab'],
    defaultBindings: {
      darwin: ['Mod+T'],
      linux: ['Mod+T'],
      win32: ['Mod+T']
    }
  }
]

function top(query: string): string | undefined {
  return rankCmdJMiddleResults({
    query,
    settingsResults: buildCmdJSettingsResults(sections),
    actionResults: buildCmdJActionResults(actions)
  })[0]?.id
}

function topWithShortcuts(
  query: string,
  bindingSearchTextByActionId: Parameters<
    typeof buildCmdJShortcutResults
  >[0]['bindingSearchTextByActionId'] = {}
): string | undefined {
  return rankCmdJMiddleResults({
    query,
    settingsResults: buildCmdJSettingsResults(sections),
    shortcutResults: buildCmdJShortcutResults({
      definitions: shortcutDefinitions,
      bindingSearchTextByActionId
    }),
    actionResults: buildCmdJActionResults(actions)
  })[0]?.id
}

describe('Cmd+J palette middle-band ranking', () => {
  it.each([
    ['new terminal', 'new-terminal-tab'],
    ['new markdown', 'new-markdown-file'],
    ['new browser', 'new-browser-tab'],
    ['create worktree', 'create-workspace'],
    ['add worktree', 'create-workspace'],
    ['new worktree', 'create-workspace'],
    ['delete worktree', 'delete-workspace'],
    ['remove worktree', 'delete-workspace'],
    ['terminal settings', 'settings:terminal'],
    ['browser settings', 'settings:browser'],
    ['ssh', 'settings:ssh'],
    ['agents', 'settings:agents'],
    ['new terminal settings', 'settings:terminal'],
    ['new mark', 'new-markdown-file'],
    ['appear', 'settings:appearance'],
    ['terminal', 'settings:terminal'],
    ['browser', 'settings:browser'],
    ['quick commands', 'settings:quick-commands'],
    ['add quick command', 'add-quick-command'],
    ['orca cli', 'settings:general:cli'],
    ['shell command', 'settings:general:cli']
  ])('ranks %s first', (query, expectedId) => {
    expect(top(query)).toBe(expectedId)
  })

  it('builds targeted settings rows for Settings subsections', () => {
    const cliResult = buildCmdJSettingsResults(sections).find(
      (result) => result.id === 'settings:general:cli'
    )

    expect(cliResult).toMatchObject({
      title: 'Orca CLI',
      description: 'Register or remove the orca shell command.',
      sectionId: 'general',
      targetSectionId: 'cli'
    })
  })

  it('does not match settings on one-character or description-only queries', () => {
    expect(top('t')).toBeUndefined()
    expect(top('cookie import')).toBeUndefined()
  })

  it('builds shortcut rows from keybinding definitions', () => {
    expect(buildCmdJShortcutResults({ definitions: shortcutDefinitions })[0]).toMatchObject({
      id: 'shortcut:terminal.splitRight',
      kind: 'shortcut',
      title: 'Split terminal right',
      description: 'Terminal shortcut',
      actionId: 'terminal.splitRight'
    })
  })

  it.each([
    ['terminal shortcut', 'shortcut:terminal.splitRight'],
    ['split terminal right shortcut', 'shortcut:terminal.splitRight'],
    ['new terminal shortcut', 'shortcut:tab.newTerminal'],
    ['keyboard shortcut terminal', 'shortcut:terminal.splitRight']
  ])('ranks shortcut query %s first', (query, expectedId) => {
    expect(topWithShortcuts(query)).toBe(expectedId)
  })

  it('uses caller-provided binding labels for shortcut ranking', () => {
    expect(topWithShortcuts('ctrl shift backslash')).toBeUndefined()
    expect(
      topWithShortcuts('ctrl shift backslash', {
        'terminal.splitRight': ['Ctrl+Shift+\\', 'Ctrl Shift \\']
      })
    ).toBe('shortcut:terminal.splitRight')
  })

  it('keeps pure settings queries ahead of shortcut rows', () => {
    expect(topWithShortcuts('terminal')).toBe('settings:terminal')
  })

  it.each([
    ['shortcut', 'settings:shortcuts'],
    ['keybinding', 'settings:shortcuts']
  ])('keeps generic %s query on the Shortcuts settings pane', (query, expectedId) => {
    expect(topWithShortcuts(query)).toBe(expectedId)
  })

  it('honors disabled-agent filtering before building shortcut results', () => {
    const filteredDefinitions = groupDefinitions(['codex']).flatMap((group) => group.items)
    const resultIds = buildCmdJShortcutResults({ definitions: filteredDefinitions }).map(
      (result) => result.actionId
    )

    expect(resultIds).not.toContain('tab.newAgent.codex')
  })

  it('does not return shortcut rows on one-character queries', () => {
    expect(topWithShortcuts('s')).toBeUndefined()
  })
})
