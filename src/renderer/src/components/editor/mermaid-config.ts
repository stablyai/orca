import type mermaid from 'mermaid'

const MERMAID_SECURE_CONFIG_KEYS = [
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'secure',
  'suppressErrorRendering',
  'maxEdges',
  'themeCSS',
  'themeVariables',
  'theme',
  'fontFamily',
  'altFontFamily',
  'htmlLabels'
]

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = false
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark ? 'dark' : 'default',
    htmlLabels,
    // Why: diagram directives are untrusted and must not re-enable HTML labels or inject theme CSS.
    secure: MERMAID_SECURE_CONFIG_KEYS
  }
}
