import { describe, expect, it } from 'vitest'
import { parsePluginAppThemeArtifact, PLUGIN_APP_THEME_TOKENS } from './plugin-theme-artifact'

describe('plugin app theme artifacts', () => {
  it('accepts color, region, geometry, state, texture, and motion tokens', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 3,
          base: 'dark',
          tokens: {
            '--background': '#101010',
            '--right-sidebar': 'rgb(20 20 20 / 90%)',
            '--appearance-panel-radius': '0px',
            '--appearance-control-hover-offset': '-1px',
            '--appearance-shadow-control': '3px 3px 0 0 #000000',
            '--appearance-state-selected': '#304050',
            '--appearance-state-selected-foreground': '#ffffff',
            '--appearance-state-selected-border': '#000000',
            '--appearance-state-border-width': '2px',
            '--appearance-worktree-sidebar-background-image':
              'repeating-linear-gradient(45deg, #ffffff08 0px, #ffffff08 1px, transparent 1px, transparent 8px)',
            '--motion-enter': '260ms',
            '--motion-ease-out': 'cubic-bezier(0.2, 1.4, 0.4, 1)'
          }
        })
      )
    ).toMatchObject({
      ok: true,
      theme: {
        schemaVersion: 3,
        base: 'dark',
        tokens: {
          '--appearance-panel-radius': '0px',
          '--appearance-control-hover-offset': '-1px',
          '--appearance-shadow-control': '3px 3px 0 0 #000000',
          '--appearance-state-selected-foreground': '#ffffff',
          '--appearance-state-selected-border': '#000000',
          '--appearance-state-border-width': '2px',
          '--appearance-worktree-sidebar-background-image': expect.stringContaining(
            'repeating-linear-gradient'
          ),
          '--motion-enter': '260ms'
        }
      }
    })
  })

  it('keeps trust-surface tokens private', () => {
    expect(PLUGIN_APP_THEME_TOKENS).not.toContain('--orca-security-background')
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'dark', tokens: { '--orca-security-background': '#000' } })
      ).ok
    ).toBe(false)
  })

  it('requires schema version 2 for geometry and motion', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'dark', tokens: { '--appearance-control-radius': '0px' } })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('schemaVersion 2') })
  })

  it('requires schema version 3 for surface textures', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 2,
          base: 'dark',
          tokens: {
            '--appearance-right-sidebar-background-image':
              'linear-gradient(135deg, #101010, #202020)'
          }
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('schemaVersion 3') })
  })

  it('accepts schema version 4 plugin-local PNG texture references', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 4,
          base: 'light',
          tokens: { '--background': '#f7ecdd' },
          textureAssets: {
            '--appearance-worktree-sidebar-background-image': 'textures/paper.png'
          }
        })
      )
    ).toMatchObject({
      ok: true,
      theme: {
        textureAssets: {
          '--appearance-worktree-sidebar-background-image': 'textures/paper.png'
        }
      }
    })
  })

  it('accepts schema version 5 links to a terminal theme contribution', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 5,
          base: 'dark',
          tokens: { '--background': '#262626' },
          terminalThemeContributionId: 'stage-terminal'
        })
      )
    ).toMatchObject({
      ok: true,
      theme: { terminalThemeContributionId: 'stage-terminal' }
    })
  })

  it('requires schema version 5 for terminal theme links', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 4,
          base: 'dark',
          tokens: { '--background': '#262626' },
          terminalThemeContributionId: 'stage-terminal'
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('schemaVersion 5') })
  })

  it.each([
    {
      schemaVersion: 3,
      textureAssets: { '--appearance-canvas-background-image': 'textures/paper.png' },
      error: 'schemaVersion 4'
    },
    {
      schemaVersion: 4,
      textureAssets: { '--background': 'textures/paper.png' },
      error: 'not a public appearance texture target'
    },
    {
      schemaVersion: 4,
      textureAssets: { '--appearance-canvas-background-image': 'textures/paper.svg' },
      error: 'PNG file'
    }
  ])('rejects invalid plugin-local texture reference $textureAssets', (input) => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: input.schemaVersion,
          base: 'light',
          tokens: { '--background': '#fff' },
          textureAssets: input.textureAssets
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining(input.error) })
  })

  it.each([
    'url(https://attacker.invalid/texture)',
    'linear-gradient(var(--foreground), #000000)',
    'paint(attacker)',
    'linear-gradient(#fff, #000); color: red'
  ])('rejects unsafe gradient value %s', (value) => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          schemaVersion: 3,
          base: 'dark',
          tokens: { '--appearance-canvas-background-image': value }
        })
      ).ok
    ).toBe(false)
  })

  it('rejects negative geometry outside interaction offsets', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ schemaVersion: 2, base: 'dark', tokens: { '--radius': '-1px' } })
      ).ok
    ).toBe(false)
  })

  it.each([
    'url(https://attacker.invalid/beacon)',
    'var(--foreground)',
    '#fff; background: #000',
    '#fff}'
  ])('rejects unsafe CSS token value %s', (value) => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'light', tokens: { '--background': value } })
      ).ok
    ).toBe(false)
  })
})
