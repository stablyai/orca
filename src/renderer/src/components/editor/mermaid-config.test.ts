// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'

import { getMermaidConfig } from './mermaid-config'

const darkColors = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  primary: '#193cb8',
  secondary: '#1447e6',
  tertiary: '#155dfc',
  border: '#8ec5ff'
}

function luminance(color: string | boolean | undefined): number {
  if (typeof color !== 'string') {
    throw new Error('Expected a resolved Mermaid color')
  }
  const hex = color === 'lightgrey' ? '#d3d3d3' : color === 'white' ? '#ffffff' : color
  if (!/^#[\da-f]{6}$/i.test(hex)) {
    throw new Error(`Unsupported contrast-test color: ${color}`)
  }
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function resolvedDarkTheme(): NonNullable<
  ReturnType<typeof mermaid.mermaidAPI.getConfig>['themeVariables']
> {
  mermaid.initialize(getMermaidConfig(true, false, darkColors))
  const variables = mermaid.mermaidAPI.getConfig().themeVariables
  if (!variables) {
    throw new Error('Mermaid did not resolve the theme')
  }
  return variables
}

describe('getMermaidConfig', () => {
  it('keeps Gantt labels readable on completed and active tasks and alternate sections', () => {
    const variables = resolvedDarkTheme()
    for (const [text, background] of [
      ['taskTextDarkColor', 'doneTaskBkgColor'],
      ['taskTextDarkColor', 'activeTaskBkgColor'],
      ['taskTextOutsideColor', 'altSectionBkgColor']
    ]) {
      const first = luminance(variables[text])
      const second = luminance(variables[background])
      const contrast = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
      expect(contrast, `${text} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives the first three pie categories distinct resolved colors', () => {
    const variables = resolvedDarkTheme()
    expect(new Set([variables.pie1, variables.pie2, variables.pie3]).size).toBe(3)
  })
})
