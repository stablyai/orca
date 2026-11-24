export const LSP_NAVIGATION_THEME_RULES = {
  '.cm-lsp-link': {
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textUnderlineOffset: '2px',
    color: 'var(--primary)',
    cursor: 'pointer'
  },
  '.cm-tooltip:has(> .cm-lsp-hover), .cm-tooltip:has(> .cm-lsp-signature)': {
    border: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none'
  },
  '.cm-tooltip .cm-lsp-hover, .cm-tooltip .cm-lsp-signature': {
    maxWidth: '560px',
    maxHeight: '280px',
    overflow: 'auto',
    padding: '6px 9px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    backgroundColor: 'var(--floating-surface)',
    color: 'var(--popover-foreground)',
    fontSize: '12px',
    lineHeight: '1.45',
    boxShadow: '0 8px 24px color-mix(in srgb, var(--background) 70%, transparent)'
  },
  '.cm-lsp-hover-code, .cm-lsp-signature-label': {
    margin: '0',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '11.5px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  '.cm-lsp-signature-active': {
    fontWeight: '700',
    color: 'var(--primary)',
    textDecoration: 'underline'
  },
  '.cm-lsp-hover-text': {
    marginTop: '4px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--muted-foreground)'
  },
  '.cm-lsp-hover-diag': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    marginBottom: '4px'
  },
  '.cm-lsp-hover-diag-badge': {
    flexShrink: '0',
    padding: '0 4px',
    borderRadius: '3px',
    fontSize: '10px',
    fontWeight: '600',
    backgroundColor: 'var(--muted)',
    color: 'var(--foreground)'
  },
  '.cm-lsp-hover-diag-error .cm-lsp-hover-diag-badge': {
    color: 'var(--destructive)'
  },
  '.cm-lsp-hover-diag-warning .cm-lsp-hover-diag-badge': {
    color: 'var(--status-warning)'
  },
  '.cm-lintRange-error': {
    textDecoration: 'underline wavy var(--destructive)'
  },
  '.cm-lintRange-warning': {
    textDecoration: 'underline wavy var(--status-warning)'
  },
  '.cm-lintRange-info, .cm-lintRange-hint': {
    textDecoration: 'underline dotted var(--muted-foreground)'
  },
  '.cm-lsp-deprecated': {
    textDecoration: 'line-through'
  },
  '.cm-lsp-unnecessary': {
    opacity: '0.62'
  }
}
