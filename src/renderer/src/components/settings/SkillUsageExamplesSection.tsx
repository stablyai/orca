import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import { SkillUsageExampleDialog } from './SkillUsageExampleDialog'

// Why: orchestration and Linear both present "How to use it" example cards that
// open a copyable prompt dialog; sharing one section keeps the two in lockstep.
export function SkillUsageExamplesSection({
  heading,
  description,
  examples,
  resolveIcon,
  slashCommand
}: {
  heading: string
  description: string
  examples: readonly SkillUsageExample[]
  resolveIcon: (example: SkillUsageExample) => LucideIcon
  slashCommand: string
}): React.JSX.Element {
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(null)

  return (
    <div className="space-y-4 border-t border-border/60 pt-6">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{heading}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {examples.map((example) => {
          const Icon = resolveIcon(example)
          return (
            <Button
              key={example.id}
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start whitespace-normal rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-left hover:bg-muted/35 hover:text-foreground"
              onClick={() => setSelectedExampleId(example.id)}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground">{example.title}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{example.summary}</p>
                </div>
              </div>
            </Button>
          )
        })}
      </div>

      {examples.map((example) => (
        <SkillUsageExampleDialog
          key={`${example.id}-dialog`}
          example={example}
          icon={resolveIcon(example)}
          slashCommand={slashCommand}
          open={selectedExampleId === example.id}
          onOpenChange={(open) => setSelectedExampleId(open ? example.id : null)}
        />
      ))}
    </div>
  )
}
