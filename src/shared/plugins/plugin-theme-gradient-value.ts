const GRADIENT_FUNCTIONS = new Set([
  'linear-gradient',
  'radial-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient'
])

const COLOR_FUNCTIONS = new Set(['hsl', 'hsla', 'oklch', 'rgb', 'rgba'])

function hasBalancedParentheses(value: string): boolean {
  let depth = 0
  for (const character of value) {
    if (character === '(') {
      depth += 1
    }
    if (character === ')') {
      depth -= 1
    }
    if (depth < 0) {
      return false
    }
  }
  return depth === 0
}

function splitLayers(value: string): string[] {
  const layers: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '(') {
      depth += 1
    }
    if (character === ')') {
      depth -= 1
    }
    if (character === ',' && depth === 0) {
      layers.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  layers.push(value.slice(start).trim())
  return layers
}

export function isSafeThemeGradient(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === 'none') {
    return true
  }
  if (!trimmed || trimmed.length > 512 || !hasBalancedParentheses(trimmed)) {
    return false
  }
  if (/url|var\s*\(|[;{}@'"\\]/i.test(trimmed)) {
    return false
  }
  if (!/^[A-Za-z0-9#.,%+\- /()]+$/.test(trimmed)) {
    return false
  }

  const functions = [...trimmed.matchAll(/([a-z-]+)\s*\(/gi)].map((match) => match[1].toLowerCase())
  if (functions.some((name) => !GRADIENT_FUNCTIONS.has(name) && !COLOR_FUNCTIONS.has(name))) {
    return false
  }
  return splitLayers(trimmed).every((layer) => {
    const functionName = /^([a-z-]+)\s*\(/i.exec(layer)?.[1]?.toLowerCase()
    return Boolean(functionName && GRADIENT_FUNCTIONS.has(functionName) && layer.endsWith(')'))
  })
}
