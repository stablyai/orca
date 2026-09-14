import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TabsContent } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { hasBoundedCommentBodyText } from '@/lib/comment-body-submit-state'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabReviewActions } from './use-gitlab-review-actions'

type Props = {
  item: GitLabWorkItem
  state: GitLabItemDialogState
  reviewActions: GitLabReviewActions
}

export function GitLabFilesTab({ item, state, reviewActions }: Props) {
  if (item.type !== 'mr') {
    return null
  }
  const {
    details,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    inlineCommentSubmitting,
    loading,
    setInlineCommentBody,
    setInlineCommentFilePath,
    setInlineCommentLine
  } = state
  const canSubmitInlineComment = hasBoundedCommentBodyText(inlineCommentBody)
  return (
    <TabsContent value="files" className="mt-0 space-y-3">
      {loading && !details ? (
        <div className="flex items-center justify-center py-12">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : details?.files?.length ? (
        <>
          <div className="rounded-md border border-border/50 bg-muted/20 p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-2">
              <select
                value={inlineCommentFilePath}
                onChange={(event) => setInlineCommentFilePath(event.target.value)}
                className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="">
                  {translate('auto.components.GitLabItemDialog.ceb08a733d', 'File')}
                </option>
                {details.files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </select>
              <input
                value={inlineCommentLine}
                onChange={(event) => setInlineCommentLine(event.target.value)}
                inputMode="numeric"
                placeholder={translate('auto.components.GitLabItemDialog.7a7204417f', 'Line')}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              />
            </div>
            <textarea
              value={inlineCommentBody}
              onChange={(event) => setInlineCommentBody(event.target.value)}
              rows={2}
              placeholder={translate(
                'auto.components.GitLabItemDialog.21f8dde18a',
                'Inline comment'
              )}
              className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
            />
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={
                  inlineCommentSubmitting ||
                  !inlineCommentFilePath ||
                  !inlineCommentLine.trim() ||
                  !canSubmitInlineComment
                }
                onClick={() => void reviewActions.handleSubmitInlineComment()}
              >
                {inlineCommentSubmitting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Send className="size-3.5" />
                )}
                {translate('auto.components.GitLabItemDialog.84012fa8fb', 'Comment')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {details.files.map((file) => (
              <div key={file.path} className="rounded-md border border-border/50 bg-muted/10">
                <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="break-all font-mono text-xs text-foreground">{file.path}</div>
                    {file.oldPath ? (
                      <div className="break-all font-mono text-[11px] text-muted-foreground">
                        {translate('auto.components.GitLabItemDialog.a7eb4f4916', 'from')}{' '}
                        {file.oldPath}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">
                    <span className="text-emerald-600">+{file.additions}</span>{' '}
                    <span className="text-rose-600">-{file.deletions}</span>
                  </div>
                </div>
                {file.diff ? (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-foreground scrollbar-sleek">
                    {file.diff}
                  </pre>
                ) : (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    {translate(
                      'auto.components.GitLabItemDialog.007423f585',
                      'Diff content unavailable.'
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.GitLabItemDialog.808b1ca1ba', 'No changed files.')}
        </p>
      )}
    </TabsContent>
  )
}
