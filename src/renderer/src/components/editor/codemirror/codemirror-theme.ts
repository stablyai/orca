import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import type { EditorTypography } from '../../../../../shared/editor/editor-typography'
import {
  openIdeaDarkHighlightStyle,
  openIdeaLightHighlightStyle
} from './codemirror-highlight-styles'
import { LSP_NAVIGATION_THEME_RULES } from './codemirror-theme-lsp'

const DEBUGGER_THEME_RULES = {
  '.cm-debug-breakpoint-gutter': {
    width: '18px',
    cursor: 'pointer'
  },
  '.cm-debug-bp-dot': {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%'
  },
  '.cm-debug-bp-dot::before': {
    content: '""',
    display: 'block',
    width: '9px',
    height: '9px',
    borderRadius: '9999px',
    boxSizing: 'border-box',
    backgroundColor: 'var(--destructive)'
  },
  '.cm-debug-bp-verified::before': {
    backgroundColor: 'var(--destructive)',
    boxShadow: '0 0 0 2px color-mix(in srgb, var(--destructive) 28%, transparent)'
  },
  '.cm-debug-bp-unverified::before': {
    backgroundColor: 'var(--muted-foreground)'
  },
  '.cm-debug-bp-disabled::before': {
    backgroundColor: 'transparent',
    border: '1.5px solid var(--destructive)'
  },
  '.cm-debug-bp-muted::before': {
    backgroundColor: 'transparent',
    border: '1.5px solid var(--muted-foreground)'
  },
  '.cm-debug-bp-conditional::before': {
    background:
      'radial-gradient(circle at 50% 50%, var(--background) 0 1.8px, var(--destructive) 2px)'
  },
  '.cm-debug-bp-log::before': {
    width: '8px',
    height: '8px',
    borderRadius: '1.5px',
    transform: 'rotate(45deg)',
    backgroundColor: 'var(--workflow-progress)'
  },
  '.cm-debug-bp-line': {
    backgroundColor: 'color-mix(in srgb, var(--destructive) 10%, transparent)'
  },
  // Stopped execution line sits below breakpoint line so paused state takes visual priority.
  '.cm-debug-stopped-line': {
    backgroundColor: 'color-mix(in srgb, var(--status-warning) 22%, transparent)',
    boxShadow: 'inset 2px 0 0 var(--status-warning)'
  },
  '.cm-debug-inline-values': {
    marginLeft: '20px',
    color: 'var(--muted-foreground)',
    fontSize: '0.88em',
    fontFamily: 'inherit',
    whiteSpace: 'pre',
    pointerEvents: 'none',
    userSelect: 'none'
  },
  '.cm-debug-inline-part': {
    pointerEvents: 'auto',
    cursor: 'pointer',
    color: 'color-mix(in srgb, var(--workflow-progress) 78%, var(--muted-foreground))'
  },
  '.cm-debug-inline-part:hover': {
    textDecoration: 'underline'
  },
  '.cm-debug-inline-more': {
    marginLeft: '4px',
    color: 'var(--workflow-progress)',
    cursor: 'pointer',
    pointerEvents: 'auto'
  },
  '.cm-tooltip:has(> .cm-debug-value-tooltip)': {
    border: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none'
  },
  '.cm-tooltip .cm-debug-value-tooltip': {
    maxWidth: '520px',
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    backgroundColor: 'var(--floating-surface)',
    color: 'var(--popover-foreground)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '12px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxShadow: '0 8px 24px color-mix(in srgb, var(--background) 70%, transparent)'
  },
  '.cm-debug-value-expand': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    marginRight: '4px',
    padding: '0',
    border: '0',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    cursor: 'pointer',
    verticalAlign: 'middle'
  },
  '.cm-debug-value-expand:hover': {
    backgroundColor: 'var(--accent)',
    color: 'var(--foreground)'
  },
  '.cm-debug-value-name': {
    color: 'var(--workflow-progress)',
    fontWeight: '500'
  },
  '.cm-debug-value-type': {
    color: 'var(--muted-foreground)'
  },
  '.cm-debug-run-to-cursor': {
    position: 'absolute',
    zIndex: '5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    padding: '0',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    backgroundColor: 'var(--floating-surface)',
    color: 'var(--status-success)',
    cursor: 'pointer',
    boxShadow: '0 2px 8px color-mix(in srgb, var(--background) 60%, transparent)'
  },
  '.cm-debug-run-to-cursor:hover': {
    backgroundColor: 'var(--accent)'
  },
  '.cm-debug-step-target': {
    borderRadius: '2px',
    boxShadow: 'inset 0 0 0 1px var(--border)',
    cursor: 'pointer'
  },
  '.cm-debug-step-target-selected': {
    backgroundColor: 'color-mix(in srgb, var(--workflow-progress) 22%, transparent)',
    boxShadow: 'inset 0 0 0 1px var(--workflow-progress)'
  }
}

const CONFLICT_AND_SELECTION_RULES = {
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 16%, transparent)',
    borderRadius: '2px'
  },
  '.cm-orca-conflict-marker': {
    backgroundColor: 'color-mix(in srgb, var(--status-warning) 22%, transparent)',
    fontWeight: '600'
  },
  '.cm-orca-conflict-current': {
    backgroundColor: 'color-mix(in srgb, var(--status-success) 14%, transparent)'
  },
  '.cm-orca-conflict-base': {
    backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 14%, transparent)'
  },
  '.cm-orca-conflict-incoming': {
    backgroundColor: 'color-mix(in srgb, var(--workflow-progress) 14%, transparent)'
  }
}

export function createOpenIdeaTheme(
  typography: EditorTypography,
  autoHeight: boolean,
  isDark = true
): Extension[] {
  const lineHeightCss = typography.lineHeight > 0 ? `${typography.lineHeight}px` : '1.5'

  const editorTheme = EditorView.theme(
    {
      '&': {
        height: autoHeight ? 'auto' : '100%',
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: typography.cssFontFamily,
        fontSize: `${typography.fontSize}px`,
        fontWeight: typography.fontWeight
      },
      '.cm-scroller': {
        fontFamily: typography.cssFontFamily,
        lineHeight: lineHeightCss,
        overflow: autoHeight ? 'visible' : 'auto'
      },
      '.cm-content': {
        padding: '6px 0',
        caretColor: 'var(--primary)',
        fontVariantLigatures: typography.fontLigatures ? 'contextual' : 'none',
        fontFeatureSettings: typography.fontLigatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--background)',
        color: 'var(--muted-foreground)',
        borderRight: '1px solid color-mix(in srgb, var(--border) 65%, transparent)',
        userSelect: 'none'
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '36px',
        padding: '0 8px 0 4px',
        textAlign: 'right',
        fontSize: '12px',
        opacity: '0.65'
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 42%, transparent)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 55%, transparent)',
        color: 'var(--foreground)'
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 28%, transparent) !important'
      },
      '.cm-cursor': {
        borderLeft: '2px solid var(--primary)'
      },
      '.cm-panels': {
        backgroundColor: 'var(--card)',
        color: 'var(--foreground)',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)'
      },
      '.cm-search': {
        fontSize: '12px',
        padding: '6px 10px'
      },
      ...CONFLICT_AND_SELECTION_RULES,
      ...DEBUGGER_THEME_RULES,
      ...LSP_NAVIGATION_THEME_RULES
    },
    { dark: isDark }
  )

  return [
    editorTheme,
    syntaxHighlighting(isDark ? openIdeaDarkHighlightStyle : openIdeaLightHighlightStyle)
  ]
}
