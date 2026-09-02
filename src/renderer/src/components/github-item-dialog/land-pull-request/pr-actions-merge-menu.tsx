import React from 'react'
import { ChevronDown, ExternalLink, GitMerge, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import type { resolveGitHubPRMergeMethods } from '../../../../../shared/github/pull-request-merge-methods'
import type { GitHubPRMergeMethod } from '../../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

export function PRActionsMergeMenu({
  itemUrl,
  mergePending,
  mergeDisabled,
  canMergeWithRepoContext,
  mergePresentation,
  mergeMethods,
  onMerge,
  onAutoMerge
}: {
  itemUrl: string
  mergePending: boolean
  mergeDisabled: boolean
  canMergeWithRepoContext: boolean
  mergePresentation: ReturnType<typeof presentGitHubPRMergeState>
  mergeMethods: ReturnType<typeof resolveGitHubPRMergeMethods>
  onMerge: (method: GitHubPRMergeMethod) => void
  onAutoMerge: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              className={cn(
                'w-full justify-center gap-2 bg-green-600 text-white hover:bg-green-700',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              {mergePending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <GitMerge className="size-3.5" />
              )}
              {mergePresentation.autoMergeAction?.label ??
                (mergePresentation.directMergeAvailable
                  ? mergeMethods.defaultLabel
                  : mergePresentation.label)}
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {!canMergeWithRepoContext
            ? translate(
                'auto.components.GitHubItemDialog.5932578f51',
                'Merge requires a registered local repo'
              )
            : mergePresentation.tooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-52">
        {mergePresentation.autoMergeAction && (
          <DropdownMenuItem
            disabled={!canMergeWithRepoContext || mergePending}
            onSelect={() => onAutoMerge()}
          >
            <GitMerge className="size-4" />
            {mergePresentation.autoMergeAction.label}
          </DropdownMenuItem>
        )}
        {mergePresentation.autoMergeAction && <DropdownMenuSeparator />}
        {mergeMethods.methods.map(({ method, label }) => (
          <DropdownMenuItem key={method} disabled={mergeDisabled} onSelect={() => onMerge(method)}>
            <GitMerge className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => window.api.shell.openUrl(itemUrl)}>
          <ExternalLink className="size-4" />
          {translate('auto.components.GitHubItemDialog.53fe19aefc', 'Open GitHub merge box')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
