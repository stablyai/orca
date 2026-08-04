import type mermaid from 'mermaid'

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = true
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    // Why: mermaid runs DOMPurify on HTML labels under "strict"; required so we
    // can enable htmlLabels without injecting unsanitized foreignObject HTML.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark ? 'dark' : 'default',
    htmlLabels
  }
}
