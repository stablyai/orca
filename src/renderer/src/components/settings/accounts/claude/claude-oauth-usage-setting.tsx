import { useTranslate } from '@/i18n/use-translate'
import { Info } from 'lucide-react'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

type ClaudeOAuthUsageSettingProps = Pick<
  AccountsPaneSectionModel,
  'settings' | 'updateSettings' | 'recordFeatureInteraction'
>

export function ClaudeOAuthUsageSetting({
  settings,
  updateSettings,
  recordFeatureInteraction
}: ClaudeOAuthUsageSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = t('accounts.claude.oauthUsage.title', 'Claude usage polling')
  const description = t(
    'accounts.claude.oauthUsage.description',
    'Uses your Claude Code sign-in to check usage, credits, and inactive accounts. Turn off to use live terminal readings only.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'usage', 'oauth', 'credentials', 'rate limit', 'status bar']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Label htmlFor="claude-oauth-usage" className="min-w-0">
          <span className="truncate">{title}</span>
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('accounts.claude.oauthUsage.about', 'About Claude usage polling')}
              className="shrink-0"
            >
              <Info className="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="max-w-xs">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      <span id="claude-oauth-usage-description" className="sr-only">
        {description}
      </span>
      <Switch
        id="claude-oauth-usage"
        aria-describedby="claude-oauth-usage-description"
        checked={settings.claudeOAuthUsageEnabled !== false}
        onCheckedChange={(checked) => {
          recordFeatureInteraction('usage-tracking')
          updateSettings({ claudeOAuthUsageEnabled: checked })
        }}
      />
    </SearchableSetting>
  )
}
