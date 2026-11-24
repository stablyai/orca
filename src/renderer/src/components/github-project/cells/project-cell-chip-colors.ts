import type React from 'react'

export function colorHex(color: string): string {
  if (!color) {
    return 'inherit'
  }
  if (color.startsWith('#')) {
    return color
  }
  return /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : color
}

const SINGLE_SELECT_HEX: Record<string, string> = {
  GRAY: '#8b949e',
  RED: '#f85149',
  ORANGE: '#db6d28',
  YELLOW: '#d29922',
  GREEN: '#3fb950',
  BLUE: '#58a6ff',
  PURPLE: '#bc8cff',
  PINK: '#db61a2'
}

type ChipColors = {
  bg: string
  fgLight: string
  fgDark: string
  border: string
}

export function chipStyle(colors: ChipColors): React.CSSProperties {
  return {
    '--github-project-chip-fg-light': colors.fgLight,
    '--github-project-chip-fg-dark': colors.fgDark,
    backgroundColor: colors.bg,
    boxShadow: `inset 0 0 0 1px ${colors.border}`
  } as React.CSSProperties
}

export function singleSelectChipColors(color: string): ChipColors {
  if (!color) {
    return labelChipColors('')
  }
  return labelChipColors(SINGLE_SELECT_HEX[color.toUpperCase()] ?? color)
}

export function labelChipColors(color: string): ChipColors {
  const fallback = {
    bg: 'rgba(125,125,125,0.18)',
    fgLight: '#4b5563',
    fgDark: '#e6edf3',
    border: 'rgba(125,125,125,0.36)'
  }
  if (!color) {
    return fallback
  }
  const hex = color.startsWith('#') ? color.slice(1) : color
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return fallback
  }
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const [h, s] = rgbToHsl(r, g, b)
  return {
    bg: `rgba(${r}, ${g}, ${b}, 0.18)`,
    border: `rgba(${r}, ${g}, ${b}, 0.3)`,
    fgLight: hslToCss(h, Math.max(s, 0.45), 0.32),
    fgDark: hslToCss(h, Math.max(s, 0.5), 0.85)
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) {
    return [0, 0, l]
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) * 60
  } else {
    h = ((rn - gn) / d + 4) * 60
  }
  return [h, s, l]
}

function hslToCss(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`
}
