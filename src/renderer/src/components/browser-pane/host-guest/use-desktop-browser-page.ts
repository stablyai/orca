import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewCreateArgs
} from '../../../../../shared/desktop-browser-view-protocol'
import {
  closeDesktopBrowserPage,
  ensureDesktopBrowserPage,
  type DesktopBrowserPage
} from './desktop-browser-page-registry'

export function useDesktopBrowserPage(
  api: DesktopBrowserViewApi | undefined,
  args: DesktopBrowserViewCreateArgs
): {
  page: DesktopBrowserPage | null
  error: unknown
  recover: () => void
} {
  const [page, setPage] = useState<DesktopBrowserPage | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [generation, setGeneration] = useState(0)
  const current = useRef(args)
  current.current = args
  const retrying = useRef(false)
  const recover = useCallback(() => {
    if (retrying.current) {
      return
    }
    retrying.current = true
    void closeDesktopBrowserPage(args.browserPageId)
      .then(() => {
        setPage(null)
        setGeneration((value) => value + 1)
      }, setError)
      .finally(() => {
        retrying.current = false
      })
  }, [args.browserPageId])
  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    setError(null)
    void ensureDesktopBrowserPage(api, current.current).then(
      (value) => {
        if (!cancelled) {
          setPage(value)
        }
      },
      (failure: unknown) => {
        if (!cancelled) {
          setError(failure)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    api,
    args.browserPageId,
    args.workspaceId,
    args.worktreeId,
    args.sessionProfileId,
    generation
  ])
  const matching =
    page &&
    page.api === api &&
    page.args.browserPageId === args.browserPageId &&
    page.args.workspaceId === args.workspaceId &&
    page.args.worktreeId === args.worktreeId &&
    page.args.sessionProfileId === args.sessionProfileId
  return { page: matching ? page : null, error, recover }
}
