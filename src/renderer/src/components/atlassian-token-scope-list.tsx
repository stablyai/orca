import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useCopyFeedbackState } from '@/components/right-sidebar/source-control/notes/copy-feedback'
import { translate } from '@/i18n/i18n'

export type AtlassianTokenScopeGroup = {
  id: string
  label: string
  scopes: readonly string[]
}

/** Scopes an Atlassian API token needs, each copyable for Atlassian's scope search. */
export function AtlassianTokenScopeList({
  groups
}: {
  groups: readonly AtlassianTokenScopeGroup[]
}): React.JSX.Element {
  const [copiedId, showCopiedId] = useCopyFeedbackState<string | null>(null)

  const copy = async (text: string, feedbackId: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(text)
      showCopiedId(feedbackId)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.atlassian.token.scope.list.copyFailed',
              'Failed to copy scopes.'
            )
      )
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.atlassian.token.scope.list.intro',
          'If you create the token with scopes, grant these:'
        )}
      </p>
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-muted-foreground">{group.label}</p>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={translate(
                'auto.components.atlassian.token.scope.list.copyGroup',
                'Copy all {{value0}} scopes',
                { value0: group.label }
              )}
              onClick={() => void copy(group.scopes.join('\n'), group.id)}
            >
              {copiedId === group.id ? <Check /> : <Copy />}
              {copiedId === group.id
                ? translate('auto.components.atlassian.token.scope.list.copied', 'Copied')
                : translate('auto.components.atlassian.token.scope.list.copyAll', 'Copy all')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.scopes.map((scope) => (
              <Button
                key={scope}
                type="button"
                variant="outline"
                size="xs"
                className="font-mono text-[11px] font-normal"
                aria-label={translate(
                  'auto.components.atlassian.token.scope.list.copyScope',
                  'Copy {{value0}}',
                  { value0: scope }
                )}
                onClick={() => void copy(scope, scope)}
              >
                {scope}
                {copiedId === scope ? (
                  <Check className="text-muted-foreground" />
                ) : (
                  <Copy className="text-muted-foreground" />
                )}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
