export function getMermaidConfig(isDark, htmlLabels = true) {
    return {
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        htmlLabels
    };
}
