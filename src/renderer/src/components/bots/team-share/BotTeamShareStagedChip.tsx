// A person picked in the Share dialog's Add field: a chip in the field until Share saves them.
import { Mail, UserRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { TeamShareSuggestion } from './bot-team-share-people'
import { LINK_ICONS } from './BotTeamShareRows'
export function stagedName(suggestion: TeamShareSuggestion): string {
  return suggestion.kind === 'invite' ? suggestion.email : suggestion.name
}

export function TeamShareStagedChip({
  suggestion,
  onRemove
}: {
  suggestion: TeamShareSuggestion
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const name = stagedName(suggestion)
  const Icon =
    suggestion.kind === 'slack' || suggestion.kind === 'github'
      ? LINK_ICONS[suggestion.kind]
      : suggestion.kind === 'invite'
        ? Mail
        : UserRound
  return (
    <Badge variant="promptPill">
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate text-[13px] font-normal">{name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5"
        aria-label={t('bots.teamShare.removePerson', 'Remove {{name}}', { name })}
        // Keep focus in the field, so typing goes on after a removal.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        <X className="size-3" />
      </Button>
    </Badge>
  )
}
