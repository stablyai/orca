import type mermaid from 'mermaid'

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = true
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    htmlLabels
  }
}
