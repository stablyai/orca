import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import {
  pluginThemeContrastFindings,
  pluginThemeContrastMessages,
  pluginThemeContrastNotes
} from './plugin-theme-contrast-findings'

function themePlugin(tokens: Record<string, string>) {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    id: 'dusk',
    name: 'Dusk',
    version: '1.0.0',
    engines: { orca: '>=1.4.246' },
    execution: 'data',
    contributes: { themes: [{ id: 'dusk-dark', title: 'Dusk', path: 'themes/dark.json' }] }
  })
  if (!parsed.ok) {
    throw new Error('manifest did not parse')
  }
  const files: Record<string, string> = {
    'themes/dark.json': JSON.stringify({
      base: 'dark',
      tokens: { '--background': '#101010', '--foreground': '#f0f0f0', ...tokens }
    })
  }
  return { manifest: parsed.manifest, read: (path: string) => files[path] ?? null }
}

describe('pluginThemeContrastFindings', () => {
  it('finds nothing for a readable theme', () => {
    const { manifest, read } = themePlugin({ '--worktree-sidebar': '#1a1a1a' })
    expect(pluginThemeContrastFindings(manifest, read)).toEqual([])
  })

  it('names what Orca will not paint and why, without a browser', () => {
    const { manifest, read } = themePlugin({
      '--worktree-sidebar': '#2a2a2a',
      '--worktree-sidebar-foreground': '#3a3a3a'
    })
    const findings = pluginThemeContrastFindings(manifest, read)
    expect(findings).toEqual([
      expect.objectContaining({
        theme: 'dusk-dark',
        base: 'dark',
        dropped: expect.arrayContaining(['--worktree-sidebar-foreground'])
      })
    ])
    expect(pluginThemeContrastMessages(findings)[0]).toMatch(
      /^contributes\.themes "dusk-dark" \(themes\/dark\.json\): --worktree-sidebar-foreground on --worktree-sidebar is 1\.\d\d:1, needs 4\.5:1/
    )
  })

  it('sets aside valid CSS it cannot resolve as a note, never an error', () => {
    const { manifest, read } = themePlugin({ '--accent': 'Canvas' })
    const findings = pluginThemeContrastFindings(manifest, read)
    expect(pluginThemeContrastMessages(findings)).toEqual([])
    expect(pluginThemeContrastNotes(findings)).toEqual([
      expect.stringContaining('not checked: --accent')
    ])
  })
})
