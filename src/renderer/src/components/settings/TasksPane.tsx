import { Check, Github, Gitlab } from 'lucide-react'
import type { GlobalSettings, TaskProvider } from '../../../../shared/types'
import {
  TASK_PROVIDERS,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type TasksPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const TASK_PROVIDER_OPTIONS: readonly {
  id: TaskProvider
  label: string
  description: string
  Icon: (props: { className?: string }) => React.JSX.Element
}[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'Show GitHub in the Tasks source picker and sidebar shortcuts.',
    Icon: ({ className }) => <Github className={className} />
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    description: 'Show GitLab in the Tasks source picker and sidebar shortcuts.',
    Icon: ({ className }) => <Gitlab className={className} />
  },
  {
    id: 'linear',
    label: 'Linear',
    description: 'Show Linear in the Tasks source picker and sidebar shortcuts.',
    Icon: ({ className }) => <LinearIcon className={className} />
  }
]

export function TasksPane({ settings, updateSettings }: TasksPaneProps): React.JSX.Element {
  const visibleProviders = normalizeVisibleTaskProviders(settings.visibleTaskProviders)

  const toggleProvider = (provider: TaskProvider): void => {
    const isVisible = visibleProviders.includes(provider)
    if (isVisible && visibleProviders.length === 1) {
      return
    }

    const nextProviders = isVisible
      ? visibleProviders.filter((entry) => entry !== provider)
      : TASK_PROVIDERS.filter((entry) => entry === provider || visibleProviders.includes(entry))

    updateSettings({
      visibleTaskProviders: nextProviders,
      defaultTaskSource: resolveVisibleTaskProvider(settings.defaultTaskSource, nextProviders)
    })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Task Sources</h3>
          <p className="text-xs text-muted-foreground">
            Choose which task providers appear in the Tasks page source picker and sidebar
            shortcuts. At least one provider must stay visible.
          </p>
        </div>

        <SearchableSetting
          title="Task Providers"
          description="Choose which task providers appear in the Tasks page and sidebar shortcuts."
          keywords={[
            'tasks',
            'provider',
            'source',
            'github',
            'gitlab',
            'linear',
            'display',
            'hide'
          ]}
          className="grid gap-2"
        >
          {TASK_PROVIDER_OPTIONS.map((option) => {
            const enabled = visibleProviders.includes(option.id)
            const isLastEnabled = enabled && visibleProviders.length === 1
            const Icon = option.Icon

            return (
              <button
                key={option.id}
                type="button"
                role="checkbox"
                aria-checked={enabled}
                aria-disabled={isLastEnabled}
                onClick={() => toggleProvider(option.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border border-border/60 px-3 py-2.5 text-left transition-colors',
                  enabled
                    ? 'bg-accent/70 text-accent-foreground'
                    : 'bg-transparent hover:bg-muted/50',
                  isLastEnabled && 'cursor-not-allowed'
                )}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-md border',
                    enabled
                      ? 'border-foreground/20 bg-background/70'
                      : 'border-border/60 bg-muted/40 text-muted-foreground'
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <Label className="cursor-inherit">{option.label}</Label>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border text-[10px]',
                    enabled
                      ? 'border-foreground/50 bg-foreground text-background'
                      : 'border-border bg-background'
                  )}
                >
                  {enabled ? <Check className="size-3" /> : null}
                </span>
              </button>
            )
          })}
        </SearchableSetting>
      </section>
    </div>
  )
}
