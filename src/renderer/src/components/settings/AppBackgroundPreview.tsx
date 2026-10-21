import type React from 'react'
import { AppBackgroundLayer } from '@/components/app-background/AppBackgroundLayer'
import {
  getAppBackgroundHostProps,
  resolveTranslucentPaneTitleBackground
} from '@/lib/app-background-appearance'
import { translate } from '@/i18n/i18n'
import type { AppBackgroundDraftValues } from '../../store/slices/app-background-draft'

// Why: decorative sample output; never translated because a real terminal shows it verbatim.
const PREVIEW_TERMINAL_LINES = [
  '$ pnpm dev',
  '> electron-vite dev',
  '  ready in 412 ms',
  '$ git status',
  'On branch main'
] as const

const PREVIEW_ROOT_STYLE: React.CSSProperties & Record<'--app-panel-alpha', string> = {
  '--app-panel-alpha': '100%'
}

type AppBackgroundPreviewProps = {
  image: { id: string; staging: boolean } | null
  values: AppBackgroundDraftValues
}

function PlaceholderBar({ className }: { className: string }): React.JSX.Element {
  return <div className={className} />
}

/** Scaled-down Orca layout that reuses the live main.css background rules via host props. */
export function AppBackgroundPreview({
  image,
  values
}: AppBackgroundPreviewProps): React.JSX.Element {
  const windowHost =
    image && values.scope === 'window'
      ? getAppBackgroundHostProps('window', values.panelOpacity)
      : undefined
  const workspaceHost =
    image && values.scope === 'workspace'
      ? getAppBackgroundHostProps('workspace', values.panelOpacity)
      : undefined
  const layer = image ? (
    <AppBackgroundLayer
      imageId={image.id}
      staging={image.staging}
      imageOpacity={values.imageOpacity}
      blur={values.blur}
    />
  ) : null
  const terminalBackground =
    resolveTranslucentPaneTitleBackground('var(--background)', values.terminalBackgroundOpacity) ??
    undefined

  return (
    <div
      role="img"
      aria-label={translate('settings.appearance.background.previewLabel', 'Background preview')}
      data-testid="app-background-preview"
      data-preview-scope={image ? values.scope : 'none'}
      className="pointer-events-none overflow-hidden rounded-lg border border-border/50 select-none"
      // Why: the settings page sits inside the live host when a window background is applied; keep its alpha out.
      style={PREVIEW_ROOT_STYLE}
    >
      <div {...windowHost} className="flex h-44 flex-col overflow-hidden bg-background">
        {windowHost ? layer : null}
        <div
          data-app-background-surface="card"
          className="flex h-4 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5"
        >
          <PlaceholderBar className="size-1.5 rounded-full bg-muted-foreground/40" />
          <PlaceholderBar className="size-1.5 rounded-full bg-muted-foreground/40" />
          <PlaceholderBar className="size-1.5 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            data-app-background-surface="worktree-sidebar"
            className="flex w-1/5 shrink-0 flex-col gap-1.5 border-r border-border bg-worktree-sidebar p-1.5"
          >
            <PlaceholderBar className="h-1.5 w-3/4 rounded-full bg-muted-foreground/30" />
            <PlaceholderBar className="h-3 w-full rounded-sm bg-accent" />
            <PlaceholderBar className="h-1.5 w-2/3 rounded-full bg-muted-foreground/30" />
            <PlaceholderBar className="h-1.5 w-1/2 rounded-full bg-muted-foreground/30" />
          </div>
          <div
            {...workspaceHost}
            data-testid="app-background-preview-workspace"
            className="flex min-w-0 flex-1 flex-col overflow-hidden"
          >
            {workspaceHost ? layer : null}
            <div
              data-app-background-surface="card"
              className="flex h-4 shrink-0 items-end gap-1 border-b border-border bg-card px-1.5"
            >
              <PlaceholderBar className="h-3 w-10 rounded-t-sm bg-background/80" />
              <PlaceholderBar className="mb-1 h-1.5 w-8 rounded-full bg-muted-foreground/30" />
            </div>
            <div
              className="min-h-0 flex-1 overflow-hidden bg-background px-1.5 py-1 font-mono text-[10px] leading-tight text-foreground/80"
              style={{ background: terminalBackground }}
            >
              {PREVIEW_TERMINAL_LINES.map((line) => (
                <div key={line} className="truncate whitespace-pre">
                  {line}
                </div>
              ))}
            </div>
          </div>
          <div
            data-app-background-surface="sidebar"
            className="flex w-1/5 shrink-0 flex-col gap-1.5 border-l border-sidebar-border bg-sidebar p-1.5"
          >
            <PlaceholderBar className="h-1.5 w-2/3 rounded-full bg-muted-foreground/30" />
            <PlaceholderBar className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
            <PlaceholderBar className="h-1.5 w-5/6 rounded-full bg-muted-foreground/20" />
          </div>
        </div>
      </div>
    </div>
  )
}
