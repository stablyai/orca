import os from 'node:os'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { shouldOpenAutoRenameBranchAdvanced } from './AutoRenameBranchFromWorkSetting'
import {
  GitPane,
  SourceControlGroupOrderSetting,
  getGitPaneSearchEntries,
  shouldShowAutoRenameBranchSetting
} from './GitPane'
import { TooltipProvider } from '../ui/tooltip'
import { matchesSettingsSearch } from './settings-search'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { CompareAgainstUpstreamSetting } from './CompareAgainstUpstreamSetting'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  for (const [key, value] of Object.entries(element.props ?? {})) {
    if (key.startsWith('on')) {
      continue
    }
    visit(value, cb)
  }
}

function findSegmentedControl(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  const label = translate(
    'auto.components.settings.GitPane.sourceControlGroupOrderTitle',
    'Source Control Group Order'
  )
  visit(node, (entry) => {
    if (entry.type === SettingsSegmentedControl && entry.props.ariaLabel === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('segmented control not found')
  }
  return found
}

function findCompareBaseSegmentedControl(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  const label = translate(
    'auto.components.settings.GitPane.compareAgainstUpstreamTitle',
    'Default Compare Base'
  )
  visit(node, (entry) => {
    if (entry.type === SettingsSegmentedControl && entry.props.ariaLabel === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('compare-base segmented control not found')
  }
  return found
}

function renderGitPane(searchQuery: string): string {
  useAppStore.setState({ settingsSearchQuery: searchQuery })
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(GitPane, {
        settings: getDefaultSettings(os.homedir()),
        updateSettings: () => {},
        writeSourceControlAiSettings: async () => {},
        displayedGitUsername: 'brennan',
        settingsSearchQuery: searchQuery
      })
    )
  )
}

describe('GitPane', () => {
  it('keeps the auto-rename branch setting visible while its prompt draft is dirty', () => {
    expect(shouldShowAutoRenameBranchSetting('zz-no-match', true)).toBe(true)
  })

  it('shows the auto-rename branch setting for advanced command-template searches', () => {
    expect(shouldShowAutoRenameBranchSetting('instructions', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('built-in prompt', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('command template', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('kebab-case', false)).toBe(true)
  })

  it('hides the auto-rename branch setting when search misses and the prompt draft is clean', () => {
    expect(shouldShowAutoRenameBranchSetting('zz-no-match', false)).toBe(false)
  })

  it('opens auto-rename advanced controls when search matches hidden command-template fields', () => {
    expect(shouldOpenAutoRenameBranchAdvanced('prompt')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('instructions')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('built-in prompt')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('command template')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('kebab-case')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('model')).toBe(false)
    expect(shouldOpenAutoRenameBranchAdvanced('thinking')).toBe(false)
  })

  it('renders auto-rename advanced controls for advanced-only search terms', () => {
    expect(renderGitPane('instructions')).toContain('Branch name command template')
    expect(renderGitPane('command template')).toContain('Branch name command template')
  })

  it('keeps auto-rename advanced controls collapsed without an advanced search match', () => {
    expect(shouldOpenAutoRenameBranchAdvanced('')).toBe(false)
    expect(shouldOpenAutoRenameBranchAdvanced('creature name')).toBe(false)
  })

  it('renders the local main freshness setting with outcome-focused copy', () => {
    const markup = renderGitPane('behind main')

    expect(markup).toContain('Keep Local Main Up to Date')
    expect(markup).toContain('git diff main...HEAD')
    expect(markup).toContain('local-only commits')
    expect(markup).not.toContain('Refresh Local Base Ref')
  })

  it('renders Source Control group order in Git settings', () => {
    const markup = renderGitPane('group order')

    expect(markup).toContain(
      translate(
        'auto.components.settings.GitPane.sourceControlGroupOrderTitle',
        'Source Control Group Order'
      )
    )
    expect(markup).toContain(
      translate('auto.components.settings.GitPane.changesFirst', 'Changes first')
    )
    expect(markup).toContain(
      translate('auto.components.settings.GitPane.stagedFirst', 'Staged first')
    )
    expect(markup).toContain(
      translate('auto.components.settings.GitPane.untrackedFirst', 'Untracked first')
    )
  })

  it('updates Source Control group order only when the selected option changes', () => {
    const updateSettings = vi.fn()
    const element = SourceControlGroupOrderSetting({
      settings: {
        ...getDefaultSettings(os.homedir()),
        sourceControlGroupOrder: 'changes-first'
      },
      updateSettings
    })

    const control = findSegmentedControl(element)
    const onChange = control.props.onChange as (value: string) => void

    onChange('staged-first')
    expect(updateSettings).toHaveBeenCalledWith({ sourceControlGroupOrder: 'staged-first' })

    updateSettings.mockClear()
    onChange('changes-first')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('includes Source Control group order search metadata', () => {
    expect(matchesSettingsSearch('staged', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('group order', getGitPaneSearchEntries())).toBe(true)
  })

  it('renders the default compare base setting in Git settings', () => {
    const markup = renderGitPane('compare base')

    expect(markup).toContain(
      translate(
        'auto.components.settings.GitPane.compareAgainstUpstreamTitle',
        'Default Compare Base'
      )
    )
    expect(markup).toContain(
      translate(
        'auto.components.settings.GitPane.compareBaseRepositoryDefault',
        'Repository default'
      )
    )
    expect(markup).toContain(
      translate('auto.components.settings.GitPane.compareBaseBranchUpstream', 'Branch upstream')
    )
    expect(markup).toContain('worktree&#x27;s Git panel')
  })

  it('includes default compare base search metadata', () => {
    expect(matchesSettingsSearch('compare base', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('worktree', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('Git panel', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('default branch', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('branch upstream', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('upstream', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('diff base', getGitPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('source control', getGitPaneSearchEntries())).toBe(true)
  })

  it('reflects the default compare base policy in its own segmented control', () => {
    const repositoryDefaultControl = findCompareBaseSegmentedControl(
      CompareAgainstUpstreamSetting({
        settings: {
          ...getDefaultSettings(os.homedir()),
          sourceControlCompareAgainstUpstream: false
        },
        updateSettings: () => {}
      })
    )
    expect(repositoryDefaultControl.props.value).toBe('repository-default')

    const branchUpstreamControl = findCompareBaseSegmentedControl(
      CompareAgainstUpstreamSetting({
        settings: {
          ...getDefaultSettings(os.homedir()),
          sourceControlCompareAgainstUpstream: true
        },
        updateSettings: () => {}
      })
    )
    expect(branchUpstreamControl.props.value).toBe('branch-upstream')
  })

  it('updates the default compare base policy from its segmented control', () => {
    const updateSettings = vi.fn()
    const repositoryDefaultControl = findCompareBaseSegmentedControl(
      CompareAgainstUpstreamSetting({
        settings: {
          ...getDefaultSettings(os.homedir()),
          sourceControlCompareAgainstUpstream: false
        },
        updateSettings
      })
    )
    ;(repositoryDefaultControl.props.onChange as (value: string) => void)('branch-upstream')
    expect(updateSettings).toHaveBeenCalledWith({ sourceControlCompareAgainstUpstream: true })

    updateSettings.mockClear()
    const branchUpstreamControl = findCompareBaseSegmentedControl(
      CompareAgainstUpstreamSetting({
        settings: {
          ...getDefaultSettings(os.homedir()),
          sourceControlCompareAgainstUpstream: true
        },
        updateSettings
      })
    )
    ;(branchUpstreamControl.props.onChange as (value: string) => void)('repository-default')
    expect(updateSettings).toHaveBeenCalledWith({ sourceControlCompareAgainstUpstream: false })
  })
})
