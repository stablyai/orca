import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  GiteaComment,
  GiteaPRCheck,
  GiteaPRFile,
  GiteaPRReviewComment,
  GiteaPullRequestDetail
} from '../../../shared/gitea-types'
import type { GiteaWorkspaceSelection } from './GiteaIssueWorkspace'
import { scoped } from './gitea-pr-request-scope'

export function useGiteaPrResources(selection: GiteaWorkspaceSelection | null) {
  const requestRef = useRef(0)
  const item = selection?.item ?? null
  const scope = selection?.scope ?? null
  const [detail, setDetail] = useState<GiteaPullRequestDetail | null>(null)
  const [files, setFiles] = useState<GiteaPRFile[]>([])
  const [checks, setChecks] = useState<GiteaPRCheck[]>([])
  const [comments, setComments] = useState<GiteaComment[]>([])
  const [reviewComments, setReviewComments] = useState<GiteaPRReviewComment[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!selection || !item || !scope) {
      return
    }
    requestRef.current += 1
    const requestId = requestRef.current
    setDetail(null)
    setFiles([])
    setChecks([])
    setComments([])
    setReviewComments([])
    setLoading(true)
    void Promise.allSettled([
      window.api.gitea.prDetail(scoped(scope, { number: item.number })),
      window.api.gitea.prFiles(scoped(scope, { number: item.number })),
      window.api.gitea.issueComments(scoped(scope, { number: item.number })),
      window.api.gitea.prReviewComments(scoped(scope, { number: item.number }))
    ])
      .then(([detailResult, filesResult, commentsResult, reviewsResult]) => {
        if (requestId !== requestRef.current) {
          return
        }
        const prDetail = detailResult.status === 'fulfilled' ? detailResult.value : null
        setDetail(prDetail)
        if (filesResult.status === 'fulfilled') {
          setFiles(filesResult.value)
        }
        if (commentsResult.status === 'fulfilled') {
          setComments(commentsResult.value)
        }
        if (reviewsResult.status === 'fulfilled') {
          setReviewComments(reviewsResult.value)
        }
        if (
          [detailResult, filesResult, commentsResult, reviewsResult].some(
            (result) => result.status === 'rejected'
          )
        ) {
          toast.error(
            translate('gitea.errors.loadPullRequest', 'Some pull request data could not be loaded.')
          )
        }
        if (prDetail?.headSha) {
          void window.api.gitea
            .prChecks(scoped(scope, { headSha: prDetail.headSha }))
            .then((result) => {
              if (requestId === requestRef.current) {
                setChecks(result)
              }
            })
            .catch(() => {
              // Why: keep checks state consistent and surface the failure.
              if (requestId === requestRef.current) {
                setChecks([])
                toast.error(
                  translate(
                    'auto.components.GiteaPullRequestWorkspace.c2d3e4f5a6',
                    'Failed to load PR checks.'
                  )
                )
              }
            })
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) {
          setLoading(false)
        }
      })
    return () => {
      requestRef.current += 1
    }
  }, [selection, item, scope])

  return {
    detail,
    setDetail,
    files,
    checks,
    comments,
    setComments,
    reviewComments,
    setReviewComments,
    loading
  }
}
