import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import { HeadIdentity } from './head-identity'

function BaseRefButton({
  baseRef,
  displayLabel,
  onClick,
  title
}: {
  baseRef: string
  displayLabel: string
  onClick: () => void
  title: string
}): React.JSX.Element {
  const t = useTranslate()
  const accessibleName = t(
    'auto.components.right.sidebar.SourceControl.c7d4e2f801',
    'Change base ref: {{value0}}',
    { value0: displayLabel }
  )
  return (
    <button
      type="button"
      className="min-w-0 max-w-full truncate rounded-sm border-0 bg-transparent p-0 text-left font-mono text-[10.5px] font-medium text-foreground/90 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
      onClick={onClick}
      title={`${title} (${baseRef})`}
      aria-label={accessibleName}
    >
      {displayLabel}
    </button>
  )
}

function BaseLine({
  baseRef,
  baseLabel,
  onChangeBaseRef,
  changeBaseTitle,
  showArrow,
  leading,
  trailing
}: {
  baseRef: string
  baseLabel: string
  onChangeBaseRef: () => void
  changeBaseTitle: string
  showArrow: boolean
  leading?: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {leading}
      {showArrow ? (
        <span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
          →
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground">
          {t('auto.components.right.sidebar.SourceControl.e8a1c4b203', 'vs')}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <BaseRefButton
          baseRef={baseRef}
          displayLabel={baseLabel}
          onClick={onChangeBaseRef}
          title={changeBaseTitle}
        />
      </span>
      {trailing}
    </div>
  )
}

// Stack head and base so narrow sidebars do not truncate both refs on one line.
export function StackedCompareFlow({
  headDisplay,
  headControl,
  baseRef,
  baseLabel,
  onChangeBaseRef,
  changeBaseTitle,
  leading,
  trailing,
  headTrailing
}: {
  headDisplay: WorktreeGitIdentityDisplay | null
  headControl?: React.ReactNode
  baseRef: string
  baseLabel: string
  onChangeBaseRef: () => void
  changeBaseTitle: string
  leading?: React.ReactNode
  trailing?: React.ReactNode
  headTrailing?: React.ReactNode
}): React.JSX.Element {
  if (!headDisplay) {
    return (
      <BaseLine
        baseRef={baseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        showArrow={false}
        leading={leading}
        // Without a head line, retain its trailing content on the base line.
        trailing={
          <>
            {headTrailing}
            {trailing}
          </>
        }
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {/* Place branch line totals beside HEAD; base-line commit counts measure comparison state. */}
      {/* Use gap-2 so colored counts do not read as part of an ellipsized branch name. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center">
          {headControl ?? <HeadIdentity display={headDisplay} />}
        </span>
        {headTrailing}
      </div>
      {/* Why: spinner/actions sit on the base line — they describe compare state, not HEAD. */}
      <BaseLine
        baseRef={baseRef}
        baseLabel={baseLabel}
        onChangeBaseRef={onChangeBaseRef}
        changeBaseTitle={changeBaseTitle}
        showArrow
        leading={leading}
        trailing={trailing}
      />
    </div>
  )
}
