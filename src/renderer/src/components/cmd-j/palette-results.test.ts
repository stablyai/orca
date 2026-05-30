import { describe, expect, it } from 'vitest'
import { Globe, Settings } from 'lucide-react'
import type { CmdJQuickAction } from './quick-actions'
import {
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  rankCmdJMiddleResults
} from './palette-results'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'

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
    title: 'Create Workspace',
    description: 'Create workspace.',
    icon: Globe,
    verbKeywords: ['create workspace', 'add workspace', 'new workspace'],
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
    id: 'ssh',
    title: 'SSH Hosts',
    description: 'Remote hosts.',
    icon: Settings,
    searchEntries: [{ title: 'Remote Shell' }],
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

function top(query: string): string | undefined {
  return rankCmdJMiddleResults({
    query,
    settingsResults: buildCmdJSettingsResults(sections),
    actionResults: buildCmdJActionResults(actions)
  })[0]?.id
}

describe('Cmd+J palette middle-band ranking', () => {
  it.each([
    ['new terminal', 'new-terminal-tab'],
    ['new markdown', 'new-markdown-file'],
    ['new browser', 'new-browser-tab'],
    ['create workspace', 'create-workspace'],
    ['add workspace', 'create-workspace'],
    ['new workspace', 'create-workspace'],
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
})
