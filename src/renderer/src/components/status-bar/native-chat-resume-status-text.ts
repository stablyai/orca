import { translate } from '@/i18n/i18n'

// What each part of the restart status-bar entry says: its label, its screen-reader name, and its
// tooltip.

export type SegmentText = { label: string; ariaLabel: string; tooltip: string }

/** Chats answered out of the chats asked, each counted as its own answer arrives. */
export function resumingText(done: number, total: number): SegmentText {
  return {
    label: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressLabel',
      'Resuming chats {{value0}}/{{value1}}',
      { value0: done, value1: total }
    ),
    ariaLabel: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingProgressAria',
      'Resuming chats, {{value0}} of {{value1}} done. Click to open details.',
      { value0: done, value1: total }
    ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.resumingTooltip',
      'Restoring interrupted chats and asking them to carry on…'
    )
  }
}

export function failedText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedLabelOne',
            '1 chat failed to resume'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedLabel',
            '{{value0}} chats failed to resume',
            { value0: count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedAriaOne',
            '1 chat failed to resume. Click for details.'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.failedAria',
            '{{value0}} chats failed to resume. Click for details.',
            { value0: count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.failedTooltip',
      'Chats Orca could not resume after the restart. Click for details.'
    )
  }
}

/** True of a refused chat and an unconfirmed one alike, for a list holding either. */
export function checkText(count: number): SegmentText {
  return {
    label:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabelOne',
            '1 chat to check'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkLabel',
            '{{value0}} chats to check',
            { value0: count }
          ),
    ariaLabel:
      count === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAriaOne',
            '1 chat to check after resuming. Click for details.'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.checkAria',
            '{{value0}} chats to check after resuming. Click for details.',
            { value0: count }
          ),
    tooltip: translate(
      'auto.components.status.bar.NativeChatResumeStatusSegment.checkTooltip',
      'Chats Orca couldn’t resume, or couldn’t confirm it resumed, after the restart. Click for details.'
    )
  }
}

/** "on studio-mac" after the count, when a paired server is the only machine with chats. */
export function nativeChatResumePendingText(
  pending: number,
  onlyMachineName: string | null,
  breakdown: readonly { count: number; name: string }[]
): SegmentText {
  const label =
    onlyMachineName === null
      ? pending === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.labelOne',
            '1 chat to resume'
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.label',
            '{{value0}} chats to resume',
            { value0: pending }
          )
      : pending === 1
        ? translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.labelOneOnMachine',
            '1 chat to resume on {{value0}}',
            { value0: onlyMachineName }
          )
        : translate(
            'auto.components.status.bar.NativeChatResumeStatusSegment.labelOnMachine',
            '{{value0}} chats to resume on {{value1}}',
            { value0: pending, value1: onlyMachineName }
          )
  const ariaLabel =
    pending === 1
      ? translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabelOne',
          '1 chat available to resume'
        )
      : translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.ariaLabel',
          '{{value0}} chats available to resume',
          { value0: pending }
        )
  const tooltip =
    breakdown.length > 1
      ? translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.tooltipByMachine',
          '{{value0}} chats to resume: {{value1}}. Click to choose.',
          {
            value0: pending,
            value1: breakdown
              .map(({ count, name }) =>
                translate(
                  'auto.components.status.bar.NativeChatResumeStatusSegment.tooltipMachinePart',
                  '{{value0}} on {{value1}}',
                  { value0: count, value1: name }
                )
              )
              .join(', ')
          }
        )
      : translate(
          'auto.components.status.bar.NativeChatResumeStatusSegment.tooltip',
          'Open interrupted chats available to resume'
        )
  return { label, ariaLabel, tooltip }
}
