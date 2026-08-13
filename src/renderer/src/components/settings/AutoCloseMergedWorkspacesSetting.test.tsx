import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES } from '../../../../shared/merged-worktree-auto-close'
import { AutoCloseMergedWorkspacesSetting } from './AutoCloseMergedWorkspacesSetting'

function render(settings: GlobalSettings): string {
  return renderToStaticMarkup(
    React.createElement(AutoCloseMergedWorkspacesSetting, { settings, updateSettings: () => {} })
  )
}

describe('AutoCloseMergedWorkspacesSetting', () => {
  it('is off for a default profile', () => {
    expect(render(getDefaultSettings('/home/test'))).toContain('data-state="unchecked"')
  })

  it('is on once the profile opts in', () => {
    const html = render({ ...getDefaultSettings('/home/test'), autoCloseMergedWorktrees: true })
    expect(html).toContain('data-state="checked"')
  })

  it('hides the grace window while the automation is off', () => {
    expect(render(getDefaultSettings('/home/test'))).not.toContain('Wait before closing')
  })

  it('offers the grace window in minutes once the automation is on', () => {
    const html = render({ ...getDefaultSettings('/home/test'), autoCloseMergedWorktrees: true })

    expect(html).toContain('Wait before closing')
    expect(html).toContain('value="10"')
    expect(html).toContain('min="0"')
    expect(html).toContain(`max="${MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES}"`)
  })

  it('shows the configured window, including zero', () => {
    const html = render({
      ...getDefaultSettings('/home/test'),
      autoCloseMergedWorktrees: true,
      autoCloseMergedWorktreesGraceMinutes: 0
    })

    expect(html).toContain('value="0"')
  })

  it('falls back to the default window when the profile never wrote one', () => {
    const settings = { ...getDefaultSettings('/home/test'), autoCloseMergedWorktrees: true }
    delete settings.autoCloseMergedWorktreesGraceMinutes

    expect(render(settings)).toContain('value="10"')
  })
})
