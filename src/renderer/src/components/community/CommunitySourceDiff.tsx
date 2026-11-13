import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CommunitySourceDiff as SourceDiff } from '../../../../shared/community-operations'
export function CommunitySourceDiff({ diff }: { diff: SourceDiff | null }): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="space-y-3 rounded-xl border border-border p-5">
      <h3 className="text-base font-semibold">
        {t('community.changedSource', 'Captured source changes')}
      </h3>
      {diff ? (
        <>
          <p className="text-xs text-muted-foreground">
            {diff.files.length} {t('community.filesCaptured', 'file records captured')}.{' '}
            {diff.complete
              ? t('community.diffComplete', 'All reported text patches fit this capture.')
              : t(
                  'community.diffPartial',
                  'Some patches are missing or truncated. Binary changes need separate inspection.'
                )}
          </p>
          <div className="max-h-96 overflow-auto scrollbar-sleek">
            {diff.files.map((file) => (
              <details className="border-b border-border py-3" key={file.path}>
                <summary className="cursor-pointer break-all font-mono text-xs">
                  {file.path} · {file.status}
                </summary>
                <div className="mt-3 space-y-2">
                  <Button variant="link" size="sm" asChild>
                    <a
                      href={`https://github.com/stablyai/orca/blob/${file.status === 'removed' ? diff.baseSha : diff.headSha}/${file.path.split('/').map(encodeURIComponent).join('/')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('community.openSourceFile', 'Open pinned source file')}
                    </a>
                  </Button>
                  <pre className="overflow-auto rounded-md bg-muted p-3 text-xs scrollbar-sleek">
                    {file.patch ??
                      t('community.noTextPatch', 'No text patch was returned for this file.')}
                  </pre>
                </div>
              </details>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            'community.diffMissing',
            'No source diff was captured. Refresh evidence before asking AI to judge the code.'
          )}
        </p>
      )}
    </section>
  )
}
