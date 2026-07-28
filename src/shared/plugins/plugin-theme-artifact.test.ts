import { describe, expect, it } from 'vitest'
import { parsePluginAppThemeArtifact, PLUGIN_APP_THEME_TOKENS } from './plugin-theme-artifact'

describe('plugin app theme artifacts', () => {
  it('accepts the curated semantic token set', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          base: 'dark',
          tokens: {
            '--background': '#101010',
            '--foreground': 'oklch(95% 0.01 250)',
            '--sidebar': 'rgb(20 20 20 / 90%)'
          }
        })
      )
    ).toEqual({
      ok: true,
      theme: {
        base: 'dark',
        tokens: {
          '--background': '#101010',
          '--foreground': 'oklch(95% 0.01 250)',
          '--sidebar': 'rgb(20 20 20 / 90%)'
        }
      }
    })
  })

  it('keeps destructive security chrome outside the public theme token set', () => {
    expect(PLUGIN_APP_THEME_TOKENS).not.toContain('--destructive')
    expect(PLUGIN_APP_THEME_TOKENS).not.toContain('--orca-security-background')
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'dark', tokens: { '--destructive': '#000' } })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('public plugin theme token set') })
  })

  it.each([
    'url(https://attacker.invalid/beacon)',
    'var(--destructive)',
    '#fff; background-image: url(https://attacker.invalid)',
    '#fff}'
  ])('rejects unsafe CSS token value %s', (value) => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({ base: 'light', tokens: { '--background': value } })
      ).ok
    ).toBe(false)
  })

  it('rejects malformed JSON and empty themes', () => {
    expect(parsePluginAppThemeArtifact('{').ok).toBe(false)
    expect(parsePluginAppThemeArtifact('{"base":"light","tokens":{}}').ok).toBe(false)
  })
})
