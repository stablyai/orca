// @vitest-environment happy-dom

import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  applyAppAppearanceToDocument,
  clearAppAppearanceFromDocument
} from './app-appearance-document'
import { APP_APPEARANCE_STYLE_PROPERTIES } from './left-sidebar-appearance'

function settings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    ...overrides
  }
}

describe('applyAppAppearanceToDocument', () => {
  beforeEach(() => {
    clearAppAppearanceFromDocument()
    document.head.replaceChildren()
    document.body.replaceChildren()
    document.documentElement.removeAttribute('style')
    document.documentElement.className = ''
    for (const property of APP_APPEARANCE_STYLE_PROPERTIES) {
      document.documentElement.style.removeProperty(property)
    }
  })

  it('writes custom app tokens and the appearance marker to the document root', () => {
    applyAppAppearanceToDocument(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#123456', foreground: '#abcdef' }
      }),
      true
    )

    expect(document.documentElement.dataset.appAppearance).toBe('match-terminal')
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--popover-foreground')).toBe('#abcdef')
    expect(document.documentElement.style.getPropertyValue('--bg-titlebar')).toContain('#123456')
  })

  it('makes document-body portal children inherit App Appearance tokens', () => {
    applyAppAppearanceToDocument(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#123456', foreground: '#abcdef' }
      }),
      true
    )
    const portal = document.createElement('div')
    document.body.append(portal)

    expect(portal.parentElement?.parentElement).toBe(document.documentElement)
    expect(document.documentElement.style.getPropertyValue('--popover-foreground')).toBe('#abcdef')
    portal.remove()
  })

  it('uses surface luminance for opposite app and terminal schemes', () => {
    const root = document.createElement('div')
    const base = settings({ leftSidebarAppearanceMode: 'match-terminal' })

    applyAppAppearanceToDocument(
      {
        ...base,
        theme: 'dark',
        terminalColorOverrides: { background: '#ffffff', foreground: '#111111' }
      },
      true,
      root
    )
    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('dark')).toBe(false)

    applyAppAppearanceToDocument(
      {
        ...base,
        theme: 'light',
        terminalColorOverrides: { background: '#101820', foreground: '#f0f4f8' }
      },
      false,
      root
    )
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
  })

  it('keeps hosted editor tokens on the configured scheme when terminal luminance is opposite', () => {
    const root = document.documentElement
    root.classList.add('dark', 'orca-editor-dark')
    root.style.setProperty('--background', '#0a0a0a')
    root.style.setProperty('--foreground', '#fafafa')
    root.style.setProperty('--primary', '#fafafa')
    root.style.setProperty('--primary-foreground', '#0a0a0a')
    root.style.setProperty('--popover', '#202020')
    root.style.setProperty('--popover-foreground', '#fafafa')
    root.style.setProperty('--editor-surface', '#1e1e1e')
    const style = document.createElement('style')
    style.textContent = `
      :root[data-app-appearance]
        :is(.rich-markdown-editor-layout, .markdown-preview-shell, .rich-markdown-link-bubble) {
        --background: var(--orca-editor-base-background);
        --foreground: var(--orca-editor-base-foreground);
        --primary: var(--orca-editor-base-primary);
        --primary-foreground: var(--orca-editor-base-primary-foreground);
        --popover: var(--orca-editor-base-popover);
        --popover-foreground: var(--orca-editor-base-popover-foreground);
        --editor-surface: var(--orca-editor-base-editor-surface);
        background: var(--editor-surface);
        color: var(--foreground);
      }
    `
    document.head.append(style)

    applyAppAppearanceToDocument(
      settings({
        theme: 'dark',
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#ffffff', foreground: '#111111' }
      }),
      true,
      root
    )
    const editor = document.createElement('div')
    editor.className = 'rich-markdown-editor-layout'
    const preview = document.createElement('div')
    preview.className = 'markdown-preview-shell'
    const linkBubble = document.createElement('div')
    linkBubble.className = 'rich-markdown-link-bubble'
    document.body.append(editor, preview, linkBubble)

    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('orca-editor-dark')).toBe(true)
    expect(root.dataset.appAppearanceBaseScheme).toBe('dark')
    expect(root.style.getPropertyValue('--orca-editor-base-editor-surface')).toBe('#1e1e1e')
    expect(root.style.getPropertyValue('--orca-editor-base-primary')).toBe('#fafafa')
    expect(root.style.getPropertyValue('--orca-editor-base-popover')).toBe('#202020')
    for (const surface of [editor, preview, linkBubble]) {
      const computed = getComputedStyle(surface)
      expect(computed.backgroundColor).toBe('#1e1e1e')
      expect(computed.color).toBe('#fafafa')
      expect(computed.getPropertyValue('--primary')).toBe('#fafafa')
      expect(computed.getPropertyValue('--primary-foreground')).toBe('#0a0a0a')
      expect(computed.getPropertyValue('--popover')).toBe('#202020')
      expect(computed.getPropertyValue('--popover-foreground')).toBe('#fafafa')
    }
  })

  it('clears every managed token and marker when returning to default', () => {
    const root = document.createElement('div')
    applyAppAppearanceToDocument(
      settings({ leftSidebarAppearanceMode: 'match-terminal' }),
      true,
      root
    )
    applyAppAppearanceToDocument(settings({ leftSidebarAppearanceMode: 'default' }), true, root)

    expect(root.hasAttribute('data-app-appearance')).toBe(false)
    expect(root.hasAttribute('data-app-appearance-base-scheme')).toBe(false)
    expect(root.style.getPropertyValue('--orca-editor-base-background')).toBe('')
    expect(root.style.getPropertyValue('--orca-editor-base-editor-surface')).toBe('')
    for (const property of APP_APPEARANCE_STYLE_PROPERTIES) {
      expect(root.style.getPropertyValue(property)).toBe('')
    }
  })

  it('recomputes terminal-derived tokens when the system preference changes', () => {
    const root = document.documentElement
    const systemSettings = settings({
      theme: 'system',
      leftSidebarAppearanceMode: 'match-terminal',
      terminalUseSeparateLightTheme: true
    })

    applyAppAppearanceToDocument(systemSettings, true, root)
    const darkBackground = root.style.getPropertyValue('--background')
    applyAppAppearanceToDocument(systemSettings, false, root)
    const lightBackground = root.style.getPropertyValue('--background')

    expect(darkBackground).not.toBe(lightBackground)
  })
})
