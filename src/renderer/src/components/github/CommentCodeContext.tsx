import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { ArrowDown, ArrowUp, Braces, LoaderCircle, UndoDot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  createCommentCodeContextExpansionState,
  resolveCommentCodeContextExpansionState,
  updateCommentCodeContextExpansionState,
  type CommentCodeContextLineUpdate
} from '@/components/comment-code-context-state'
import { getPrCommentCodeContext } from '@/components/github/pr-comment-code-context'
import { getPRFileContentsRenderLimit } from '@/components/github/pr-file-diff-mapping'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { PRComment } from '../../../../shared/github/comment-types'
import type {
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents
} from '../../../../shared/github/pull-request-types'

const MonacoCodeExcerpt = lazy(() => import('@/components/editor/MonacoCodeExcerpt'))

const CODE_CONTEXT_EXPAND_STEP = 5
const CODE_CONTEXT_FALLBACK_LINES = 20
const CODE_CONTEXT_MAX_BLOCK_LINES = CODE_CONTEXT_FALLBACK_LINES * 2 + 1

/** Why: each host owns a private PR file-contents cache, so the loader is injected instead of shared. */
export type LoadPRFileContents = (args: {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  file: GitHubPRFile
  headSha: string
  baseSha: string
}) => Promise<GitHubPRFileContents>

export function CommentCodeContext({
  comment,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  files,
  headSha,
  baseSha,
  loadPRFileContents
}: {
  comment: PRComment
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  loadPRFileContents: LoadPRFileContents
}): React.JSX.Element | null {
  const [contents, setContents] = useState<GitHubPRFileContents | null>(null)
  const [error, setError] = useState(false)
  const [contextExpansionState, setContextExpansionState] = useState(() =>
    createCommentCodeContextExpansionState(comment.id)
  )
  const file = useMemo(
    () => files.find((candidate) => candidate.path === comment.path),
    [comment.path, files]
  )
  const line = comment.line
  const startLine = comment.startLine ?? line

  useEffect(() => {
    setContents(null)
    setError(false)
    if (!repoPath || !file || !headSha || !baseSha || !line || file.isBinary) {
      return
    }
    let cancelled = false
    loadPRFileContents({
      repoPath,
      repoId,
      sourceContext,
      prNumber,
      prRepo,
      file,
      headSha,
      baseSha
    })
      .then((result) => {
        if (!cancelled) {
          setContents(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    baseSha,
    file,
    headSha,
    line,
    loadPRFileContents,
    prNumber,
    prRepo,
    repoId,
    repoPath,
    sourceContext
  ])

  const resolvedContextExpansionState = resolveCommentCodeContextExpansionState(
    contextExpansionState,
    comment.id
  )
  if (resolvedContextExpansionState !== contextExpansionState) {
    // Why: comment rows can be reused on PR refresh; reset before paint so the previous comment's expanded context isn't shown on the next.
    setContextExpansionState(resolvedContextExpansionState)
  }
  const contextBefore = resolvedContextExpansionState.contextBefore
  const contextAfter = resolvedContextExpansionState.contextAfter
  const setContextBefore = useCallback(
    (contextBeforeUpdate: CommentCodeContextLineUpdate) => {
      setContextExpansionState((current) =>
        updateCommentCodeContextExpansionState(current, comment.id, {
          contextBefore: contextBeforeUpdate
        })
      )
    },
    [comment.id]
  )
  const setContextAfter = useCallback(
    (contextAfterUpdate: CommentCodeContextLineUpdate) => {
      setContextExpansionState((current) =>
        updateCommentCodeContextExpansionState(current, comment.id, {
          contextAfter: contextAfterUpdate
        })
      )
    },
    [comment.id]
  )

  if (!comment.path || !line || !file || file.isBinary || error) {
    return null
  }

  if (!contents) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {translate('auto.components.GitHubItemDialog.db61d76cd5', 'Loading code context…')}
      </div>
    )
  }

  if (getPRFileContentsRenderLimit(contents).limited) {
    return null
  }

  const source = contents.modified || contents.original
  const codeContext = getPrCommentCodeContext({
    source,
    line,
    startLine,
    contextBefore,
    contextAfter,
    fallbackLines: CODE_CONTEXT_FALLBACK_LINES,
    maxBlockLines: CODE_CONTEXT_MAX_BLOCK_LINES
  })
  if (!codeContext) {
    return null
  }
  const {
    selectedLines,
    totalLines,
    commentFrom,
    commentTo,
    from,
    to,
    blockRange,
    shouldUseBlockRange,
    canExpandAbove,
    canExpandBelow,
    canExpandBlock
  } = codeContext
  const language = detectLanguage(comment.path)
  const blockTooltip = shouldUseBlockRange
    ? 'Show surrounding code block'
    : 'Show nearby code context'

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50 bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono">{comment.path}</span>
          <span className="shrink-0 font-mono">
            L{from}
            {to !== from
              ? translate('auto.components.GitHubItemDialog.d1c0dad471', '-L{{value0}}', {
                  value0: to
                })
              : ''}
          </span>
          {(from !== commentFrom || to !== commentTo) && (
            <span className="shrink-0 font-mono text-muted-foreground/70">
              {translate('auto.components.GitHubItemDialog.bd7be7b1fd', 'comment L')}
              {commentFrom}
              {commentTo !== commentFrom
                ? translate('auto.components.GitHubItemDialog.d1c0dad471', '-L{{value0}}', {
                    value0: commentTo
                  })
                : ''}
            </span>
          )}
        </div>
        <ButtonGroup
          className="text-muted-foreground"
          aria-label={translate(
            'auto.components.GitHubItemDialog.d43736d09c',
            'Code context controls'
          )}
        >
          {(contextBefore > 0 || contextAfter > 0) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setContextBefore(0)
                    setContextAfter(0)
                  }}
                  aria-label={translate(
                    'auto.components.GitHubItemDialog.b1574e8ac2',
                    'Reset code context'
                  )}
                >
                  <UndoDot className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {translate('auto.components.GitHubItemDialog.b1574e8ac2', 'Reset code context')}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandAbove}
                onClick={() =>
                  setContextBefore((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, commentFrom - 1)
                  )
                }
                aria-label={translate(
                  'auto.components.GitHubItemDialog.307c98e8e3',
                  'Show {{value0}} more lines above',
                  { value0: CODE_CONTEXT_EXPAND_STEP }
                )}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('auto.components.GitHubItemDialog.5664681624', 'Show more lines above')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBelow}
                onClick={() =>
                  setContextAfter((current) =>
                    Math.min(current + CODE_CONTEXT_EXPAND_STEP, totalLines - commentTo)
                  )
                }
                aria-label={translate(
                  'auto.components.GitHubItemDialog.307c98e8e3',
                  'Show {{value0}} more lines below',
                  { value0: CODE_CONTEXT_EXPAND_STEP }
                )}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('auto.components.GitHubItemDialog.06c06e58ba', 'Show more lines below')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="size-7 border-border/55 bg-background/35 text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                disabled={!canExpandBlock}
                onClick={() => {
                  setContextBefore((current) =>
                    Math.max(current, Math.max(0, commentFrom - blockRange.startLine))
                  )
                  setContextAfter((current) =>
                    Math.max(current, Math.max(0, blockRange.endLine - commentTo))
                  )
                }}
                aria-label={blockTooltip}
              >
                <Braces className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{blockTooltip}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>
      <Suspense
        fallback={
          <pre className="overflow-x-auto py-1 text-[12px] leading-5">
            {selectedLines.map((codeLine, index) => {
              const lineNumber = from + index
              const isCommentedLine = lineNumber >= commentFrom && lineNumber <= commentTo
              return (
                <div
                  key={lineNumber}
                  className={cn('flex font-mono', isCommentedLine && 'bg-emerald-500/10')}
                >
                  <span className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground">
                    {lineNumber}
                  </span>
                  <code className="min-w-0 flex-1 px-3 text-foreground">{codeLine || ' '}</code>
                </div>
              )
            })}
          </pre>
        }
      >
        <MonacoCodeExcerpt
          lines={selectedLines}
          firstLineNumber={from}
          highlightedStartLine={commentFrom}
          highlightedEndLine={commentTo}
          language={language}
        />
      </Suspense>
    </div>
  )
}
