import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import type { RepoCommandKind } from '../../../../../../shared/repo-command-kind'

const ARTIFACT_URL_TEMPLATE_TOKEN = '{{artifact_url}}'

export function RepositoryIssueCommandSetting({
  issueCommandDraft,
  setIssueCommandDraft,
  hasSharedIssueCommand,
  issueCommandSaveError,
  issueCommandReadOnly,
  issueCommandStoppedDistro,
  commitIssueCommand,
  kind
}: {
  issueCommandDraft: string
  setIssueCommandDraft: (value: string) => void
  hasSharedIssueCommand: boolean
  issueCommandSaveError: string | null
  issueCommandReadOnly: boolean
  issueCommandStoppedDistro: string | null
  commitIssueCommand: () => Promise<void>
  kind: RepoCommandKind
}): React.JSX.Element {
  const COPY: Record<RepoCommandKind, { title: string; placeholder: string; description: string }> =
    {
      issue: {
        title: translate(
          'auto.components.settings.RepositoryHooksSection.13394103bd',
          'Custom GitHub Issue Command'
        ),
        placeholder: translate(
          'auto.components.settings.RepositoryHooksSection.4084720f47',
          'Complete {{artifact_url}}',
          { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
        ),
        description: translate(
          'auto.components.settings.RepositoryHooksSection.issueCommandDescription',
          'Optional override. Use <artifactUrl>{{artifact_url}}</artifactUrl> for the linked issue or PR URL.',
          { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
        )
      },
      review: {
        title: translate(
          'auto.components.settings.RepositoryIssueCommandSetting.e21e26b8ea',
          'Custom Review Command'
        ),
        placeholder: translate(
          'auto.components.settings.RepositoryIssueCommandSetting.66af9e725a',
          'Review {{artifact_url}}',
          { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
        ),
        description: translate(
          'auto.components.settings.RepositoryIssueCommandSetting.reviewCommandDescription',
          'Optional override. Use <artifactUrl>{{artifact_url}}</artifactUrl> for the linked pull or merge request URL.',
          { artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }
        )
      }
    }
  const copy = COPY[kind]
  return (
    <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
      <div className="space-y-1">
        <h5 className="text-sm font-semibold">{copy.title}</h5>
        <p className="text-xs text-muted-foreground">
          <Trans
            i18n={i18n}
            defaults={copy.description}
            values={{ artifact_url: ARTIFACT_URL_TEMPLATE_TOKEN }}
            components={{ artifactUrl: <code className="rounded bg-muted px-1 py-0.5" /> }}
          />
        </p>
      </div>
      <textarea
        value={issueCommandDraft}
        aria-label={copy.title}
        readOnly={issueCommandReadOnly}
        onChange={(event) => setIssueCommandDraft(event.target.value)}
        onBlur={() => void commitIssueCommand()}
        placeholder={copy.placeholder}
        rows={4}
        spellCheck={false}
        className="w-full min-w-0 resize-y rounded-md border border-input bg-muted/20 px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:italic placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
      />
      <p className="text-[11px] text-muted-foreground">
        <Trans
          i18n={i18n}
          defaults={
            hasSharedIssueCommand
              ? translate(
                  'auto.components.settings.RepositoryHooksSection.issueCommandSharedDefault',
                  'Leave blank to use the repo default from <yaml>orca.yaml</yaml>.'
                )
              : translate(
                  'auto.components.settings.RepositoryHooksSection.issueCommandOptionalDefault',
                  'Leave blank to use the repo default from <yaml>orca.yaml</yaml> when one exists.'
                )
          }
          components={{ yaml: <code className="rounded bg-muted px-1 py-0.5" /> }}
        />
      </p>
      {issueCommandStoppedDistro ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryHooksSection.issueCommandWslStopped',
            'WSL distro {{distro}} is stopped. Open a terminal in it to see or edit this command.',
            { distro: issueCommandStoppedDistro }
          )}
        </p>
      ) : null}
      {issueCommandSaveError ? (
        <p className="text-xs text-destructive">{issueCommandSaveError}</p>
      ) : null}
    </div>
  )
}
