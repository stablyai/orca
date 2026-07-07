import { describe, expect, it } from 'vitest'
import { parseCssTheme, parseJsonTheme, parseTheme } from './custom-ui-themes'

describe('custom ui themes parser', () => {
  it('parses raw Tailwind v4 CSS string successfully', () => {
    const cssInput = `
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(0.9578 0.0058 264.5321);
  --foreground: oklch(0.4355 0.0430 279.3250);
  --card: oklch(1.0000 0 0);
  --sidebar: oklch(0.9335 0.0087 264.5206);
}

.dark {
  --background: oklch(0.2155 0.0254 284.0647);
  --foreground: oklch(0.8787 0.0426 272.2767);
  --card: oklch(0.2429 0.0304 283.9110);
  --sidebar: oklch(0.1828 0.0204 284.2039);
}
`
    const themes = parseCssTheme('Claude', cssInput)
    expect(themes).toHaveLength(2)

    const lightTheme = themes.find((t) => t.mode === 'light')!
    expect(lightTheme).toBeDefined()
    expect(lightTheme.name).toBe('Claude Light')
    expect(lightTheme.variables['--background']).toBe('oklch(0.9578 0.0058 264.5321)')
    expect(lightTheme.variables['--sidebar']).toBe('oklch(0.9335 0.0087 264.5206)')

    const darkTheme = themes.find((t) => t.mode === 'dark')!
    expect(darkTheme).toBeDefined()
    expect(darkTheme.name).toBe('Claude Dark')
    expect(darkTheme.variables['--background']).toBe('oklch(0.2155 0.0254 284.0647)')
    expect(darkTheme.variables['--sidebar']).toBe('oklch(0.1828 0.0204 284.2039)')
  })

  it('ignores non-css-variable statements and parses complex values', () => {
    const cssInput = `
:root {
  --font-sans: Montserrat, sans-serif;
  --radius: 0.35rem;
  --shadow-sm: 0px 4px 6px 0px hsl(240 30% 25% / 0.12);
  --background: hsl(240 10% 90%);
}
`
    const themes = parseCssTheme('Test', cssInput)
    expect(themes).toHaveLength(1)
    const theme = themes[0]!
    expect(theme.variables['--font-sans']).toBe('Montserrat, sans-serif')
    expect(theme.variables['--radius']).toBe('0.35rem')
    expect(theme.variables['--background']).toBe('hsl(240 10% 90%)')
  })

  it('parses Shadcn JSON theme successfully', () => {
    const jsonInput = `
{
  "name": "Catppuccin",
  "cssVars": {
    "light": {
      "background": "0 0% 100%",
      "foreground": "240 10% 3.9%",
      "primary": "240 5.9% 10%"
    },
    "dark": {
      "background": "240 10% 3.9%",
      "foreground": "0 0% 98%",
      "primary": "0 0% 98%"
    }
  }
}
`
    const themes = parseJsonTheme(jsonInput)
    expect(themes).toHaveLength(2)

    const lightTheme = themes.find((t) => t.mode === 'light')!
    expect(lightTheme.name).toBe('Catppuccin Light')
    expect(lightTheme.variables['--background']).toBe('hsl(0 0% 100%)')
    expect(lightTheme.variables['--primary']).toBe('hsl(240 5.9% 10%)')

    const darkTheme = themes.find((t) => t.mode === 'dark')!
    expect(darkTheme.name).toBe('Catppuccin Dark')
    expect(darkTheme.variables['--background']).toBe('hsl(240 10% 3.9%)')
    expect(darkTheme.variables['--primary']).toBe('hsl(0 0% 98%)')
  })

  it('parseTheme auto-detects CSS input', () => {
    const themes = parseTheme('Auto', ':root { --primary: red; }')
    expect(themes).toHaveLength(1)
    const theme = themes[0]!
    expect(theme.mode).toBe('light')
    expect(theme.name).toBe('Auto Light')
    expect(theme.variables['--primary']).toBe('red')
  })

  it('parseTheme auto-detects JSON input', () => {
    const jsonInput = JSON.stringify({
      name: 'Test',
      cssVars: { dark: { primary: '0 0% 10%' } }
    })
    const themes = parseTheme('Ignored', jsonInput)
    expect(themes).toHaveLength(1)

    const theme = themes[0]!
    expect(theme.mode).toBe('dark')
    expect(theme.name).toBe('Test Dark')
    expect(theme.variables['--primary']).toBe('hsl(0 0% 10%)')
  })

  it('parses JSON themes with shared cssVars.theme block', () => {
    const jsonInput = `
{
  "name": "Shared",
  "cssVars": {
    "theme": {
      "radius": "0.55rem",
      "font-sans": "Inter"
    },
    "light": {
      "background": "0 0% 100%"
    },
    "dark": {
      "background": "0 0% 0%"
    }
  }
}
`
    const themes = parseJsonTheme(jsonInput)
    expect(themes).toHaveLength(2)

    const lightTheme = themes.find((t) => t.mode === 'light')!
    expect(lightTheme.variables['--radius']).toBe('0.55rem')
    expect(lightTheme.variables['--font-sans']).toBe('Inter')
    expect(lightTheme.variables['--background']).toBe('hsl(0 0% 100%)')

    const darkTheme = themes.find((t) => t.mode === 'dark')!
    expect(darkTheme.variables['--radius']).toBe('0.55rem')
    expect(darkTheme.variables['--font-sans']).toBe('Inter')
    expect(darkTheme.variables['--background']).toBe('hsl(0 0% 0%)')
  })

  it('filters out values containing url() for safety', () => {
    const jsonInput = `
{
  "name": "Unsafe JSON",
  "cssVars": {
    "light": {
      "background": "0 0% 100%",
      "malicious": "url('http://malicious.com/pixel.png')"
    }
  }
}
`
    const jsonThemes = parseJsonTheme(jsonInput)
    expect(jsonThemes).toHaveLength(1)
    expect(jsonThemes[0]!.variables['--background']).toBe('hsl(0 0% 100%)')
    expect(jsonThemes[0]!.variables['--malicious']).toBeUndefined()

    const cssInput = `
:root {
  --background: hsl(0 0% 100%);
  --unsafe-bg: url("http://unsafe.com/pixel.png");
}
`
    const cssThemes = parseCssTheme('Unsafe CSS', cssInput)
    expect(cssThemes).toHaveLength(1)
    expect(cssThemes[0]!.variables['--background']).toBe('hsl(0 0% 100%)')
    expect(cssThemes[0]!.variables['--unsafe-bg']).toBeUndefined()
  })
})
