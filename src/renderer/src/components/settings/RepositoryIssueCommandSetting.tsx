import { translate } from '@/i18n/i18n'

const ARTIFACT_URL_TEMPLATE_TOKEN = '{{artifact_url}}'

export function RepositoryIssueCommandSetting({
  issueCommandDraft,
  setIssueCommandDraft,
  hasSharedIssueCommand,
  issueCommandSaveError,
  commitIssueCommand
}: {
  issueCommandDraft: string
  setIssueCommandDraft: (value: string) => void
  hasSharedIssueCommand: boolean
  issueCommandSaveError: string | null
  commitIssueCommand: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
      <div className="space-y-1">
        <h5 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryHooksSection.13394103bd',
            'Custom GitHub Issue Command'
          )}
        </h5>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryHooksSection.b997331366',
            'Optional override. Use'
          )}{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            {translate(
              'auto.components.settings.RepositoryHooksSection.c85c2c88a2',
              '{{artifact_url}}',
              { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
            )}
          </code>{' '}
          {translate(
            'auto.components.settings.RepositoryHooksSection.70ad20f883',
            'for the linked issue or PR URL.'
          )}
        </p>
      </div>
      <textarea
        value={issueCommandDraft}
        aria-label={translate(
          'auto.components.settings.RepositoryHooksSection.13394103bd',
          'Custom GitHub Issue Command'
        )}
        onChange={(event) => setIssueCommandDraft(event.target.value)}
        onBlur={() => void commitIssueCommand()}
        placeholder={translate(
          'auto.components.settings.RepositoryHooksSection.4084720f47',
          'Complete {{artifact_url}}',
          { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
        )}
        rows={4}
        spellCheck={false}
        className="w-full min-w-0 resize-y rounded-md border border-input bg-muted/20 px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
      />
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.RepositoryHooksSection.52aef29e69',
          'Leave blank to use the repo default from'
        )}{' '}
        <code className="rounded bg-muted px-1 py-0.5">
          {translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml')}
        </code>
        {hasSharedIssueCommand
          ? '.'
          : translate(
              'auto.components.settings.RepositoryHooksSection.9b12f15b1e',
              'when one exists.'
            )}
      </p>
      {issueCommandSaveError ? (
        <p className="text-xs text-destructive">{issueCommandSaveError}</p>
      ) : null}
    </div>
  )
}
