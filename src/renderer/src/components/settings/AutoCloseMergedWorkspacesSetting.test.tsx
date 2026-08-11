import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
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
})
