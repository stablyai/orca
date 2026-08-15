import { Bot, Box, Clock, Code2, FolderOpen, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { DiscoveredSkill, SkillProvider, SkillSourceKind } from '../../../../shared/skills'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

const skillProviderLabels: Record<SkillProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'agent-skills': 'Agent Skills'
}

export function getSkillSourceLabel(sourceKind: SkillSourceKind): string {
  switch (sourceKind) {
    case 'home':
      return translate('auto.components.skills.SkillsPage.571c5818c1', 'Home')
    case 'repo':
      return translate('auto.components.skills.SkillsPage.aa59462502', 'Repository')
    case 'bundled':
      return translate('auto.components.skills.SkillsPage.4d177feabd', 'Bundled')
    case 'plugin':
      return translate('auto.components.skills.SkillsPage.984405683f', 'Plugin')
  }
}

const RELATIVE_TIME_UNITS = [
  { unit: 'year', seconds: 60 * 60 * 24 * 365 },
  { unit: 'month', seconds: 60 * 60 * 24 * 30 },
  { unit: 'week', seconds: 60 * 60 * 24 * 7 },
  { unit: 'day', seconds: 60 * 60 * 24 },
  { unit: 'hour', seconds: 60 * 60 },
  { unit: 'minute', seconds: 60 }
] as const

function formatSkillUpdatedAt(value: number | null): string {
  if (!value) {
    return translate('auto.components.skills.SkillsPage.5f8ad7efc1', 'Unknown')
  }
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - value) / 1000))
  for (const { unit, seconds } of RELATIVE_TIME_UNITS) {
    if (elapsedSeconds >= seconds) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' }).format(
        -Math.floor(elapsedSeconds / seconds),
        unit
      )
    }
  }
  return translate('auto.components.skills.SkillsPage.6e4ef57af8', 'Just now')
}

function pluralizeSkillFiles(count: number): string {
  return count === 1
    ? translate('auto.components.skills.SkillsPage.c2a6a5dd13', '1 file')
    : translate('auto.components.skills.SkillsPage.a421c52a18', '{{count}} files', { count })
}

function ProviderGlyph({ providers }: { providers: readonly SkillProvider[] }): React.JSX.Element {
  const primaryProvider = providers[0] ?? 'agent-skills'
  const Icon = primaryProvider === 'codex' ? Code2 : primaryProvider === 'claude' ? Sparkles : Bot
  // Why: fall the label back to the primary provider too, so an empty providers
  // list does not render an empty aria-label / tooltip alongside the glyph.
  const label =
    providers.length > 0
      ? providers.map((provider) => skillProviderLabels[provider]).join(', ')
      : skillProviderLabels[primaryProvider]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground"
        >
          <Icon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function DiscoveredSkillCard({
  skill,
  duplicateCount = 1
}: {
  skill: DiscoveredSkill
  duplicateCount?: number
}): React.JSX.Element {
  const revealSkill = async (): Promise<void> => {
    const result = await window.api.shell.openInFileManager(skill.skillFilePath)
    if (!result.ok) {
      toast.error(
        translate('auto.components.skills.SkillsPage.995fde8337', 'Could not reveal skill file')
      )
    }
  }

  return (
    <Card className="h-full rounded-lg py-0 shadow-xs">
      <CardContent className="flex h-full flex-col gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderGlyph providers={skill.providers} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h3>
              {duplicateCount > 1 ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.skills.SkillsPage.c16750a08a',
                    '{{count}} locations',
                    { count: duplicateCount }
                  )}
                </span>
              ) : null}
            </div>
            {skill.description ? (
              <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                {skill.description}
              </p>
            ) : (
              <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
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
              <span className="block max-w-[28rem] truncate">
                {translate('auto.components.skills.SkillsPage.dc4c3328ee', 'Reveal file')}:{' '}
                {skill.skillFilePath}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="h-5 text-[10px]">
            {getSkillSourceLabel(skill.sourceKind)}
          </Badge>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Box className="size-3" />
            {pluralizeSkillFiles(skill.fileCount)}
          </span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Clock className="size-3" />
            {formatSkillUpdatedAt(skill.updatedAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
