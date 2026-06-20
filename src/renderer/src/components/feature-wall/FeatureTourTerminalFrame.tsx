import type { JSX } from 'react'
import { ClaudeIcon } from '../status-bar/icons'
import { translate } from '@/i18n/i18n'

export function FeatureTourTerminalFrame(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-5 bg-card px-4 py-4">
      <div className="text-[14.5px] font-semibold uppercase tracking-[0.07em] leading-none text-muted-foreground">
        {translate(
          'auto.components.feature.wall.FeatureTourPreview.1aa8a9a24a',
          'Splittable terminal'
        )}
      </div>
      <div className="mx-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1">
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="ml-2 font-mono text-[13.5px] leading-none text-muted-foreground">
            {translate('auto.components.feature.wall.FeatureTourPreview.04d54d50ec', 'orca · zsh')}
          </span>
        </div>
        <div className="grid flex-1 grid-cols-2 divide-x divide-border font-mono text-[14.5px] leading-[1.4] text-foreground">
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="feature-tour-terminal-line relative inline-block whitespace-nowrap text-foreground">
                {translate(
                  'auto.components.feature.wall.FeatureTourPreview.6218a9014d',
                  'pnpm playwright test'
                )}
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output truncate text-muted-foreground"
                data-line="1"
              >
                {translate(
                  'auto.components.feature.wall.FeatureTourPreview.8279e9d95b',
                  'Running 12 tests'
                )}
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="2"
              >
                <span className="font-bold text-emerald-600">✓</span>
                <span className="truncate">
                  {translate(
                    'auto.components.feature.wall.FeatureTourPreview.24fedd5a52',
                    'login.spec.ts'
                  )}
                </span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground" />
                <span className="truncate">
                  {translate(
                    'auto.components.feature.wall.FeatureTourPreview.6ed43cb0e0',
                    'dashboard.spec.ts'
                  )}
                </span>
              </div>
            </div>
          </div>
          <div className="min-w-0 p-2">
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">$</span>
              <span className="text-foreground">
                {translate('auto.components.feature.wall.FeatureTourPreview.771d8881c2', 'claude')}
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="1"
              >
                <ClaudeIcon size={12} />
                <span className="truncate text-muted-foreground">
                  {translate(
                    'auto.components.feature.wall.FeatureTourPreview.952d3ddd9a',
                    'session started'
                  )}
                </span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1"
                data-line="2"
              >
                <span className="text-amber-600">
                  {translate('auto.components.feature.wall.FeatureTourPreview.1170621527', '>')}
                </span>
                <span className="truncate">
                  {translate(
                    'auto.components.feature.wall.FeatureTourPreview.ef8b164dd1',
                    'review src/auth'
                  )}
                </span>
              </div>
              <div
                className="feature-tour-terminal-output flex min-w-0 items-center gap-1.5"
                data-line="3"
              >
                <span className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-amber-600/20 border-t-amber-600" />
                <span className="truncate text-muted-foreground">
                  {translate(
                    'auto.components.feature.wall.FeatureTourPreview.304ad0dfc1',
                    'Thinking...'
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
