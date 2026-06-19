import type mermaid from 'mermaid'

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = false
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark ? 'dark' : 'default',
    htmlLabels
  }
}
