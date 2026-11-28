import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  DictationPillElapsed,
  DictationPillFinishButton,
  DictationPillStatus,
  DictationPillWords
} from '@/components/dictation/DictationIndicator'
import { DictationGrapes } from '@/components/dictation/DictationGrapes'
import { DictationPillCloseButton } from '@/components/dictation/DictationPillFailure'
import { DictationPillShell } from '@/components/dictation/DictationPillShell'
import { NativeChatWorkingStatus } from '@/components/native-chat/conversation/turns/NativeChatWorkingStatus'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useShortcutKeyDetails } from '@/lib/keyboard/useShortcutLabel'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  FeatureTipChatCard,
  FeatureTipChatComposer,
  FeatureTipChatUserBubble
} from './FeatureTipChatCard'
import { FeatureTipKeycaps } from './FeatureTipKeycaps'
import {
  createDictationDemoTimeline,
  DICTATION_DEMO_PLAYS,
  DICTATION_DEMO_SLOT_GROW_MS,
  type DictationDemoFrame
} from './voice-dictation-feature-tip-demo'

const DEMO_WORKED_SECONDS = 52
const noop = (): void => {}

/** The app's own listening pill, laid out in flow and driven by the demo clock. */
function DemoDictationPill({ frame }: { frame: DictationDemoFrame }): JSX.Element {
  const t = useTranslate()
  return (
    <DictationPillShell anchor={null} inline testId="feature-tip-dictation-pill">
      <DictationPillCloseButton
        label={t('auto.components.dictation.DictationIndicator.cancel', 'Cancel')}
        onClick={noop}
      />
      <DictationGrapes level={frame.level} active />
      {frame.heard ? (
        <DictationPillWords committed={frame.heard} tentative="" speechPending={false} />
      ) : (
        <DictationPillStatus
          label={t('auto.components.dictation.DictationIndicator.listening', 'Listening…')}
        />
      )}
      <DictationPillElapsed seconds={frame.seconds} />
      <DictationPillFinishButton
        label={t('auto.components.dictation.DictationIndicator.finish', 'Finish')}
      />
    </DictationPillShell>
  )
}

/** A chat tab where the shortcut starts dictation and spoken words land in the composer; plays twice. */
export function VoiceDictationFeatureTipVisual(): JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const reducedMotion = usePrefersReducedMotion()
  // No platform fallback: when dictation is unassigned the dialog asks the user to assign one, so no key is shown.
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const firstPhrase = t(
    'featureTips.voice.demoFirstPhrase',
    'The checkout button overlaps the footer on small screens.'
  )
  const secondPhrase = t('featureTips.voice.demoSecondPhrase', 'Can you add a test?')
  const timeline = useMemo(
    () => createDictationDemoTimeline(firstPhrase, secondPhrase, intlLocale),
    [firstPhrase, secondPhrase, intlLocale]
  )
  const [clock, setClock] = useState({ at: 0, play: 1 })
  const finished = clock.play >= DICTATION_DEMO_PLAYS && clock.at >= timeline.endAt
  const frame = timeline.frameAt(reducedMotion ? timeline.endAt : clock.at)

  useEffect(() => {
    if (reducedMotion || finished) {
      return
    }
    const next = timeline.nextBeat(clock.at)
    const timeoutId = window.setTimeout(
      () =>
        setClock(
          next >= timeline.loopAt ? { at: 0, play: clock.play + 1 } : { at: next, play: clock.play }
        ),
      next - clock.at
    )
    return () => window.clearTimeout(timeoutId)
  }, [clock, finished, reducedMotion, timeline])

  return (
    // Inert: the pill's real buttons must not reach the app's dictation controls.
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
      inert
    >
      <div className="relative w-full max-w-[22rem]">
        <FeatureTipChatCard
          tabTitle={t('featureTips.voice.demoTabTitle', 'Checkout footer')}
          footer={
            <>
              {/* Grows in flow, so the transcript slides up as the pill appears above the composer. */}
              <div
                data-on={frame.listening}
                className="h-0 shrink-0 px-4 transition-[height] ease-out data-[on=true]:h-[2.625rem]"
                style={{ transitionDuration: `${DICTATION_DEMO_SLOT_GROW_MS}ms` }}
              >
                {frame.pill ? <DemoDictationPill frame={frame} /> : null}
              </div>
              <FeatureTipChatComposer
                send={frame.draft ? 'ready' : 'empty'}
                draft={
                  frame.draft ? (
                    <span className="whitespace-normal text-chat-foreground-strong">
                      {frame.draft}
                    </span>
                  ) : null
                }
              />
            </>
          }
        >
          <div className="mb-4">
            <FeatureTipChatUserBubble>
              {t('featureTips.voice.demoUserPrompt', 'Add payment badges')}
            </FeatureTipChatUserBubble>
          </div>
          <NativeChatWorkingStatus
            startedAt={null}
            workedSeconds={DEMO_WORKED_SECONDS}
            onToggleExpanded={noop}
          />
          <p className="mt-3 mb-2">
            {t('featureTips.voice.demoReply', 'Added payment badges to the checkout footer.')}
          </p>
        </FeatureTipChatCard>
        {/* In the empty band between the tab bar and the user's message, so the keys cover no text. */}
        {frame.keys === 'hidden' ? null : (
          <FeatureTipKeycaps
            shortcut={shortcut}
            pressed={frame.keys === 'pressed'}
            macGlyphs
            className="absolute top-14 left-1/2 -translate-x-1/2 transition-opacity duration-150 starting:opacity-0"
          />
        )}
      </div>
    </div>
  )
}
