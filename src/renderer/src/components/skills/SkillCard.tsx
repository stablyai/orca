import { BookOpen, Clock, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DiscoveredSkill, SkillProvider } from '../../../../shared/skills'
import { pluralize, sourceLabels } from './skill-display-labels'

const providerLabels: Record<SkillProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'agent-skills': 'Agent Skills'
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function formatUpdatedAt(value: number | null): string {
  return value ? dateFormatter.format(new Date(value)) : 'Unknown'
}

export function SkillCard({ skill }: { skill: DiscoveredSkill }): React.JSX.Element {
  const revealSkill = async (): Promise<void> => {
    const result = await window.api.shell.openInFileManager(skill.skillFilePath)
    if (!result.ok) {
      toast.error(
        translate('auto.components.skills.SkillsPage.995fde8337', 'Could not reveal skill file')
      )
    }
  }

  return (
    <Card className="rounded-lg">
      <CardContent className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
            <BookOpen className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h3>
              <Badge
                variant={skill.installed ? 'secondary' : 'outline'}
                className="h-5 text-[10px]"
              >
                {skill.installed
                  ? translate('auto.components.skills.SkillsPage.0c74e7ff34', 'Installed')
                  : translate('auto.components.skills.SkillsPage.35b9a724a0', 'Available')}
              </Badge>
              <Badge variant="outline" className="h-5 text-[10px]">
                {sourceLabels[skill.sourceKind]}
              </Badge>
            </div>
            {skill.description ? (
              <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                {skill.description}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {translate('auto.components.skills.SkillsPage.9963dff6d3', 'No description found.')}
              </p>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => {
                  void revealSkill()
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('auto.components.skills.SkillsPage.dc4c3328ee', 'Reveal file')}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="grid gap-2 text-[11px] text-muted-foreground md:grid-cols-[1fr_auto_auto] md:items-center">
          <div className="min-w-0 truncate font-mono" title={skill.skillFilePath}>
            {skill.skillFilePath}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {skill.providers.map((provider) => (
              <Badge key={provider} variant="outline" className="h-5 text-[10px]">
                {providerLabels[provider]}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span>{skill.sourceLabel}</span>
            <span>{pluralize(skill.fileCount, 'file')}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {formatUpdatedAt(skill.updatedAt)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
