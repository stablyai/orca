import type { MermaidThemeColors } from './mermaid-config'

export function readMermaidThemeColors(): MermaidThemeColors | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) {
    return undefined
  }
  const styles = getComputedStyle(document.documentElement)
  const readColor = (token: string): string => {
    // Mermaid needs hex colors; chart tokens can resolve to oklch().
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = styles.getPropertyValue(token).trim()
    context.fillRect(0, 0, 1, 1)
    const pixel = context.getImageData(0, 0, 1, 1).data
    return `#${Array.from(pixel.slice(0, 3), (channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  return {
    background: readColor('--background'),
    foreground: readColor('--foreground'),
    primary: readColor('--chart-5'),
    secondary: readColor('--chart-4'),
    tertiary: readColor('--chart-3'),
    border: readColor('--chart-1')
  }
}
