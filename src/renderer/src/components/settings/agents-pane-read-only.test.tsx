import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentsPaneReadOnlyNotice,
  guardAgentsPaneWrite,
  resolveAgentsPaneReadOnly
} from './agents-pane-read-only'

const webFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }

afterEach(() => {
  delete webFlag.__ORCA_WEB_CLIENT__
})

describe('agents pane read-only', () => {
  it('lets an explicit value override client detection', () => {
    webFlag.__ORCA_WEB_CLIENT__ = true
    expect(resolveAgentsPaneReadOnly(false)).toBe(false)
    webFlag.__ORCA_WEB_CLIENT__ = false
    expect(resolveAgentsPaneReadOnly(true)).toBe(true)
  })

  it('treats a paired web client window as read-only by default', () => {
    expect(resolveAgentsPaneReadOnly()).toBe(false)
    webFlag.__ORCA_WEB_CLIENT__ = true
    expect(resolveAgentsPaneReadOnly()).toBe(true)
  })

  it('runs the write only when the pane is editable', () => {
    const write = vi.fn()
    guardAgentsPaneWrite(true, write)
    expect(write).not.toHaveBeenCalled()
    guardAgentsPaneWrite(false, write)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('points the notice at the desktop app', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentsPaneReadOnlyNotice))
    expect(markup).toContain('Agent settings are managed on the desktop')
    expect(markup).toContain('use the Orca desktop app')
    expect(markup).toContain('role="note"')
  })
})
