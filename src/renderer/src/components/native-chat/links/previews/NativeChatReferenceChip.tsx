import { isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { cn } from '@/lib/class-names'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { NativeChatLinkPeekContext } from './native-chat-link-peek-context'
import {
  githubLinkPreviewKey,
  loadGitHubLinkPreview,
  readCachedGitHubLinkPreview
} from './native-chat-github-link-preview'
import { LinearStateDot, useLinearIssuePreview } from './NativeChatLinearLinkPeek'
import {
  GitLabItemIcon,
  JiraStatusDot,
  useGitLabWorkItemPreview,
  useJiraIssuePreview
} from './NativeChatTrackerLinkPeek'
import {
  resolveNativeChatTrackerLink,
  trackerLinkLabel,
  type NativeChatTrackerLink
} from './native-chat-tracker-links'
import type { GitLabChatLink } from './native-chat-tracker-link-previews'
import { useNativeChatHoverPreview } from './use-native-chat-hover-preview'

function textOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) {
    return children.map(textOf).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return textOf(children.props.children)
  }
  return ''
}

// `#12`, `!12`, `repo#12`, `group/project!12`, `PR #12`, `MR !12`: the label says no more than the URL does.
const BARE_NUMBER_LABEL =
  /^(?:(?:PR|MR|pr|mr|issue|Issue)\s*)?(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?[#!]\d+$/

function isBareLabel(label: string, href: string, link: NativeChatTrackerLink): boolean {
  if (label === href || label === href.replace(/^https?:\/\//, '')) {
    return true
  }
  if (label === trackerLinkLabel(link)) {
    return true
  }
  return link.kind === 'github' || link.kind === 'gitlab'
    ? BARE_NUMBER_LABEL.test(label)
    : label.toUpperCase() === (link.kind === 'linear' ? link.identifier : link.issueKey)
}

/** A link whose text only repeats its target's ID or URL, so a chip with the title can replace it.
 *  Links the author gave their own words keep them. */
export function useNativeChatReference(
  href: string | undefined,
  children: ReactNode
): NativeChatTrackerLink | null {
  const peek = useContext(NativeChatLinkPeekContext)
  if (!href || peek.referenceChips === 'off') {
    return null
  }
  const link = resolveNativeChatTrackerLink(peek, href)
  return link && isBareLabel(textOf(children).trim(), href, link) ? link : null
}

/** True once the element has come near the viewport, so a long transcript asks only for what is read. */
function useSeen(): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (seen || !element) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen]
}

function ChipId({ link }: { link: NativeChatTrackerLink }): React.JSX.Element {
  return <span className="native-chat-ref-chip-id">{trackerLinkLabel(link)}</span>
}

function ChipTitle({ title }: { title: string | null | undefined }): React.JSX.Element | null {
  return title ? <span className="native-chat-ref-chip-title">{title}</span> : null
}

const GITHUB_STATE_CLASS: Record<GitHubWorkItem['state'], string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  draft: 'text-muted-foreground',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-red-600 dark:text-red-400'
}

function GitHubChipIcon({ state }: { state?: GitHubWorkItem['state'] }): React.JSX.Element {
  return (
    <GitHubIcon aria-hidden className={cn('size-3 shrink-0', state && GITHUB_STATE_CLASS[state])} />
  )
}

function LinearChip({ link }: { link: NativeChatTrackerLink & { kind: 'linear' } }) {
  const { state } = useLinearIssuePreview(link.identifier)
  const issue = state.status === 'ready' ? state.value : null
  return (
    <>
      {issue ? <LinearStateDot color={issue.state.color} /> : null}
      <ChipId link={link} />
      <ChipTitle title={issue?.title} />
    </>
  )
}

function JiraChip({ link }: { link: NativeChatTrackerLink & { kind: 'jira' } }) {
  const { state } = useJiraIssuePreview(link.siteId, link.issueKey)
  const issue = state.status === 'ready' ? state.value : null
  return (
    <>
      {issue ? <JiraStatusDot categoryKey={issue.status.categoryKey} /> : null}
      <ChipId link={link} />
      <ChipTitle title={issue?.title} />
    </>
  )
}

function GitHubChip({
  link,
  repo,
  issue
}: {
  link: NativeChatTrackerLink
  repo: Repo
  issue: GitHubIssueOrPRLink
}) {
  const { state } = useNativeChatHoverPreview(
    githubLinkPreviewKey(repo, issue),
    () => readCachedGitHubLinkPreview(repo, issue),
    () => loadGitHubLinkPreview(repo, issue)
  )
  const item = state.status === 'ready' ? state.value : null
  return (
    <>
      <GitHubChipIcon state={item?.state} />
      <ChipId link={link} />
      <ChipTitle title={item?.title} />
    </>
  )
}

function GitLabChip({
  link,
  repo,
  target
}: {
  link: NativeChatTrackerLink
  repo: Repo
  target: GitLabChatLink
}) {
  const { state } = useGitLabWorkItemPreview(repo, target)
  const item = state.status === 'ready' ? state.value : null
  return (
    <>
      <GitLabItemIcon type={target.type} state={item?.state} />
      <ChipId link={link} />
      <ChipTitle title={item?.title} />
    </>
  )
}

function CompactChip({ link }: { link: NativeChatTrackerLink }): React.JSX.Element {
  return (
    <>
      {link.kind === 'github' ? <GitHubChipIcon /> : null}
      {link.kind === 'gitlab' ? <GitLabItemIcon type={link.link.type} /> : null}
      <ChipId link={link} />
    </>
  )
}

function FullChip({ link }: { link: NativeChatTrackerLink }): React.JSX.Element {
  switch (link.kind) {
    case 'linear':
      return <LinearChip link={link} />
    case 'jira':
      return <JiraChip link={link} />
    case 'github':
      return <GitHubChip link={link} repo={link.repo} issue={link.link} />
    case 'gitlab':
      return <GitLabChip link={link} repo={link.repo} target={link.link} />
  }
}

/** The reference as a chip: its ID, plus its title and state once known unless the setting is compact. */
export function NativeChatReferenceChip({
  reference,
  fallback
}: {
  reference: NativeChatTrackerLink
  /** What the link showed before, kept until the chip is on screen. */
  fallback: ReactNode
}): React.JSX.Element {
  const { referenceChips } = useContext(NativeChatLinkPeekContext)
  const [ref, seen] = useSeen()
  // Compact chips never ask for a title, so they skip the wait for the viewport too.
  const details =
    referenceChips === 'compact' ? (
      <CompactChip link={reference} />
    ) : seen ? (
      <FullChip link={reference} />
    ) : (
      fallback
    )
  return (
    <span ref={ref} className="native-chat-ref-chip" data-native-chat-ref-chip={reference.kind}>
      {details}
    </span>
  )
}
