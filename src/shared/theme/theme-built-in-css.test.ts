import { describe, expect, it } from 'vitest'
import { themeBuiltInValuesFromCss } from './theme-built-in-css'

const CSS = `
/* comment with :root { --background: red; } */
:root {
  --background: #fff;
  --accent: var(--missing, var(--background));
  --mask: url("data:image/svg+xml;utf8,<svg>{}</svg>");
  &[data-x] { --background: #f00; }
  --border: color-mix(in srgb, var(--foreground) 10%, transparent);
  --foreground: #111;
}
@media (prefers-contrast: more) { :root { --background: #000; } }
@layer base { :root, .other { --card: #fafafa; } }
.dark {
  --background: #0a0a0a;
  --foreground: #eee;
}
`

describe('themeBuiltInValuesFromCss', () => {
  const values = themeBuiltInValuesFromCss(CSS, [
    '--background',
    '--accent',
    '--border',
    '--card',
    '--ring'
  ])

  it('reads :root for light, then .dark over it for dark, skipping media and nested rules', () => {
    expect(values.light['--background']).toBe('#fff')
    expect(values.dark['--background']).toBe('#0a0a0a')
    expect(values.light['--card']).toBe('#fafafa')
  })

  it('substitutes var() with fallbacks per mode, as a computed custom property does', () => {
    expect(values.light['--accent']).toBe('#fff')
    expect(values.dark['--accent']).toBe('#0a0a0a')
    expect(values.light['--border']).toBe('color-mix(in srgb, #111 10%, transparent)')
    expect(values.dark['--border']).toBe('color-mix(in srgb, #eee 10%, transparent)')
  })

  it('leaves an undeclared token empty', () => {
    expect(values.light['--ring']).toBe('')
  })
})
