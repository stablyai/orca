export function getMermaidConfig(isDark: boolean, htmlLabels = true) {
  return {
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    htmlLabels
  }
}
