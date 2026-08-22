import React, { useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { BeadsIssue } from '../../../shared/beads-types'

const BODY_MARKDOWN_CLASS =
  'min-w-0 max-w-full overflow-hidden break-words text-[14px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full'

function BodySectionHeading({ label }: { label: string }): React.JSX.Element {
  return (
    <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {label}
    </h4>
  )
}

function BodySection({ label, content }: { label: string; content: string }): React.JSX.Element {
  return (
    <div className="border-t border-border/50 px-4 py-4">
      <BodySectionHeading label={label} />
      <CommentMarkdown content={content} variant="document" className={BODY_MARKDOWN_CLASS} />
    </div>
  )
}

/** Notes accrues via `--append-notes` and grows longest of the body slots, so it starts folded. */
function CollapsedNotesSection({ content }: { content: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const label = translate('auto.components.TaskPage.beadsBodyNotes', 'Notes')
  return (
    <div className="border-t border-border/50 px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 py-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {expanded ? (
        <div className="pt-2">
          <CommentMarkdown content={content} variant="document" className={BODY_MARKDOWN_CLASS} />
        </div>
      ) : null}
    </div>
  )
}

type BeadsItemDetailBodySectionsProps = {
  issue: BeadsIssue
  /** True while the first `bd show` is in flight — the body slots may still be about to enrich. */
  pending: boolean
}

/**
 * The four bd body slots. Description always renders (matching `bd show`);
 * design/acceptance criteria/notes are omitted by bd when empty, so each
 * section appears only when present.
 */
export function BeadsItemDetailBodySections({
  issue,
  pending
}: BeadsItemDetailBodySectionsProps): React.JSX.Element {
  const description = issue.description ?? ''
  return (
    <>
      <div className="px-4 py-4 text-[14px] leading-relaxed text-foreground">
        {pending ? (
          <div className="flex items-center justify-center py-5">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : description.trim() ? (
          <CommentMarkdown
            content={description}
            variant="document"
            className={BODY_MARKDOWN_CLASS}
          />
        ) : (
          <span className="italic text-muted-foreground">
            {translate('auto.components.GitHubItemDialog.9b9cb55994', 'No description provided.')}
          </span>
        )}
      </div>
      {!pending && issue.design ? (
        <BodySection
          label={translate('auto.components.TaskPage.beadsBodyDesign', 'Design')}
          content={issue.design}
        />
      ) : null}
      {!pending && issue.acceptanceCriteria ? (
        <BodySection
          label={translate(
            'auto.components.TaskPage.beadsBodyAcceptanceCriteria',
            'Acceptance criteria'
          )}
          content={issue.acceptanceCriteria}
        />
      ) : null}
      {!pending && issue.notes ? <CollapsedNotesSection content={issue.notes} /> : null}
    </>
  )
}
