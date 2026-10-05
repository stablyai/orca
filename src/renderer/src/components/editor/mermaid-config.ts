import type mermaid from 'mermaid'

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = true
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    // Strict mode sanitizes label HTML and disables diagram click callbacks.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark ? 'dark' : 'default',
    htmlLabels
  }
}
