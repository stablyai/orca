// The Automation screen's When and Results sections: each reads as a line or two, and its Edit
// opens the page editor's own fields in place, saved through the shared section save.
import React, { useEffect, useId, useRef } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import type { Bot } from '../../../../shared/bot-types'
import { buildBotAutomationSectionDraft } from '../automations/authoring/automation-edit-draft'
import type { AutomationDraft } from '../automations/authoring/AutomationEditorDialog'
import {
  AutomationBotResultsFields,
  AutomationBotWhenFields
} from '../automations/authoring/AutomationBotSectionFields'
import {
  botSectionBase,
  botAutomationEditBase,
  botSectionDraftError,
  botSectionPatch,
  saveBotAutomationSection,
  type BotAutomationSection,
  type BotSectionSaveResult
} from '../automations/authoring/automation-bot-section-save'
import { botTargetChatTitle } from '../automations/authoring/automation-bot-runs-in-chat'
import {
  automationResultsPlace,
  automationWhenLines,
  automationZoneLabel
} from '../automations/details/automation-bot-facts'
import { DetailSection } from '../automations/details/automation-detail-sections'
import {
  softDisabledProps,
  type AutomationControlState
} from '../automations/details/AutomationDetailHeader'
import type { AutomationDetailsController } from '../automations/details/automation-details-controller'
import { updateAutomationForOwner } from '../automations/hosts/automation-scoped-list-client'
import { showAutomationForOwner } from '../automations/hosts/automation-owner-reads'
import { AutomationHostScopeUnsupportedError } from '../automations/hosts/automation-capability-probe'
import type { Editing } from './use-bot-automation-editing'

function EditButton({
  label,
  ariaLabel,
  state,
  onPress,
  buttonRef
}: {
  label: string
  ariaLabel: string
  state: AutomationControlState
  onPress: () => void
  buttonRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  // Native disabled would drop focus; aria-disabled keeps it, so the wrapper dims it.
  return (
    <span className={state.unavailable || state.pending ? 'opacity-50' : undefined}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="xs"
        aria-label={ariaLabel}
        {...softDisabledProps(state, onPress)}
      >
        <Pencil />
        {label}
      </Button>
    </span>
  )
}

export type SectionProps = {
  bot: Bot
  automation: Automation
  owner: AutomationOwnerRef
  controller: AutomationDetailsController
  screenKey: string
  editing: Editing | null
  setEditing: React.Dispatch<React.SetStateAction<Editing | null>>
  /** Why Edit can't open now (offline, old host, …); null when it can. */
  editState: AutomationControlState
  /** The bot's computer as notices name it. */
  hostName: string
  onSaved: () => void
  onUnsupported: () => void
  askInChat: ((sentence: string) => void) | null
}

function SectionEditor({
  section,
  props,
  editRef
}: {
  section: BotAutomationSection
  props: SectionProps
  editRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const { editing, setEditing, controller, automation, bot } = props
  const saveRef = useRef<HTMLButtonElement>(null)
  const saveMineRef = useRef<HTMLButtonElement>(null)
  const errorId = useId()
  useEffect(() => {
    if (editing?.conflict) {
      saveMineRef.current?.focus()
    }
  }, [editing?.conflict])
  if (!editing || editing.section !== section) {
    return null
  }
  // A save the host refused as too old is said beside Save until a newer answer lets Edit back on.
  const refusal = t(
    'bots.automationPanel.updateOrcaToSave',
    'Update Orca on {{host}} to save here.',
    {
      host: props.hostName
    }
  )
  const error = editing.error === refusal && !props.editState.unavailable ? null : editing.error
  const change = (updater: (current: AutomationDraft) => AutomationDraft): void =>
    setEditing((current) => (current ? { ...current, draft: updater(current.draft) } : current))
  const close = (): void => {
    // Discards the kept draft too, unless this editor already closed and a newer one holds it.
    setEditing(null)
    requestAnimationFrame(() => editRef.current?.focus())
  }
  const valid = !botSectionDraftError(section, editing.draft)
  const changed =
    Object.keys(botSectionPatch(section, editing.savedAutomation, editing.draft, 0)).length > 0
  const save = (force: boolean): void => {
    if (
      editing.saving ||
      props.editState.unavailable ||
      props.editState.pending ||
      !valid ||
      !changed
    ) {
      return
    }
    const invalid = botSectionDraftError(section, editing.draft)
    if (invalid) {
      setEditing({ ...editing, error: invalid })
      return
    }
    setEditing({ ...editing, saving: true, error: null })
    void controller
      .mutate(
        (owner) =>
          saveBotAutomationSection({
            section,
            base: editing.base,
            draft: editing.draft,
            force,
            now: Date.now(),
            reread: () => showAutomationForOwner(owner, automation.id),
            write: (updates, unchangedSince) =>
              updateAutomationForOwner(owner, automation.id, updates, undefined, {
                unchangedSince,
                required: true
              })
          }),
        (result: BotSectionSaveResult) =>
          result.kind === 'saved'
            ? result.automation
            : result.kind === 'conflict'
              ? result.latest
              : null
      )
      .then((result) => {
        if (result.kind === 'conflict') {
          setEditing((current) =>
            current ? { ...current, saving: false, conflict: result.latest } : current
          )
          return
        }
        props.onSaved()
        close()
      })
      .catch((error: unknown) => {
        if (error instanceof AutomationHostScopeUnsupportedError) {
          props.onUnsupported()
          // Said beside Save, not only in the notice above: the press that failed is here.
          setEditing((current) =>
            current ? { ...current, saving: false, error: refusal } : current
          )
          requestAnimationFrame(() => saveRef.current?.focus())
          return
        }
        setEditing((current) =>
          current
            ? {
                ...current,
                saving: false,
                error: t('bots.automationPanel.saveFailed', "Couldn't save.")
              }
            : current
        )
        requestAnimationFrame(() => saveRef.current?.focus())
      })
  }
  const takeLatest = (latest: Automation): void => {
    setEditing({
      section,
      draft: buildBotAutomationSectionDraft(latest),
      savedAutomation: botAutomationEditBase(latest),
      base: botSectionBase(section, latest),
      restored: false,
      saving: false,
      error: null,
      conflict: null
    })
  }
  const target = editing.draft.bot
  const saveState = {
    ...props.editState,
    unavailable: props.editState.unavailable || !valid || !changed,
    pending: editing.saving || props.editState.pending
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 py-3 @max-[16rem]:px-3">
      {editing.restored ? (
        <p className="text-xs text-muted-foreground">
          {t('bots.automationPanel.draftKept', 'Unsaved change kept from earlier')}
        </p>
      ) : null}
      {section === 'when' ? (
        <AutomationBotWhenFields
          draft={editing.draft}
          label={t('automations.botTarget.when', 'When')}
          labelHidden
          onDraftChange={change}
          askInChat={props.askInChat}
        />
      ) : target ? (
        <AutomationBotResultsFields
          draft={editing.draft}
          target={target}
          resultsOnly
          bot={bot}
          onDraftChange={change}
        />
      ) : null}
      {editing.conflict ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs"
        >
          <span>
            {t(
              'bots.automationPanel.conflict',
              'This changed while you were editing. Latest: {{latest}}',
              {
                latest:
                  section === 'when'
                    ? automationWhenLines(editing.conflict).join(' · ')
                    : automationResultsPlace(editing.conflict.bot?.resultsTo)
              }
            )}
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Button
              ref={saveMineRef}
              type="button"
              size="xs"
              aria-disabled={saveState.pending || saveState.unavailable || undefined}
              aria-busy={saveState.pending || undefined}
              aria-describedby={saveState.unavailable ? saveState.describedBy : undefined}
              onClick={() => save(true)}
            >
              {t('bots.automationPanel.saveMine', 'Save mine')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => editing.conflict && takeLatest(editing.conflict)}
            >
              {t('bots.automationPanel.useLatest', 'Use latest')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            ref={saveRef}
            type="button"
            size="xs"
            aria-disabled={saveState.pending || saveState.unavailable || undefined}
            aria-busy={saveState.pending || undefined}
            onClick={() => save(false)}
            aria-describedby={
              error ? errorId : saveState.unavailable ? saveState.describedBy : undefined
            }
          >
            {error
              ? t('bots.automationPanel.tryAgain', 'Try again')
              : editing.saving
                ? t('bots.automationPanel.saving', 'Saving…')
                : t('common.save', 'Save')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={close}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      )}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function startEditing(section: BotAutomationSection, props: SectionProps): void {
  props.setEditing({
    section,
    draft: buildBotAutomationSectionDraft(props.automation),
    savedAutomation: botAutomationEditBase(props.automation),
    base: botSectionBase(section, props.automation),
    restored: false,
    saving: false,
    error: null,
    conflict: null
  })
}

export function BotAutomationWhenSection(props: SectionProps): React.JSX.Element {
  const t = useTranslate()
  const editRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const { automation, owner, editing } = props
  const zone = automationZoneLabel(automation, owner.authority)
  const open = editing?.section === 'when'
  return (
    <DetailSection
      title={t('automations.botTarget.when', 'When')}
      titleId={titleId}
      actions={
        open ? null : (
          <EditButton
            buttonRef={editRef}
            label={t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
            ariaLabel={t('bots.automationPanel.editWhen', 'Edit when it runs')}
            state={editing ? { ...props.editState, unavailable: true } : props.editState}
            onPress={() => startEditing('when', props)}
          />
        )
      }
    >
      {open ? (
        <SectionEditor section="when" props={props} editRef={editRef} />
      ) : (
        <div className="flex min-w-0 flex-col gap-1 px-4 py-3 text-[13px] @max-[16rem]:px-3">
          {automationWhenLines(automation).map((line) => (
            <p key={line} className="[overflow-wrap:anywhere]">
              {line}
            </p>
          ))}
          {zone ? (
            <p className="text-xs text-muted-foreground">
              {t('bots.automationPanel.zone', 'Times are in {{zone}}', { zone })}
            </p>
          ) : null}
        </div>
      )}
    </DetailSection>
  )
}

export function BotAutomationResultsSection(props: SectionProps): React.JSX.Element {
  const t = useTranslate()
  const editRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const { automation, editing } = props
  const open = editing?.section === 'results'
  return (
    <DetailSection
      title={t('components.native-chat.automationSaved.results', 'Results')}
      titleId={titleId}
      actions={
        open || !automation.bot ? null : (
          <EditButton
            buttonRef={editRef}
            label={t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
            ariaLabel={t('bots.automationPanel.editResults', 'Edit where results go')}
            state={editing ? { ...props.editState, unavailable: true } : props.editState}
            onPress={() => startEditing('results', props)}
          />
        )
      }
    >
      {open ? (
        <SectionEditor section="results" props={props} editRef={editRef} />
      ) : (
        <div className="flex min-w-0 flex-col gap-1 px-4 py-3 text-[13px] @max-[16rem]:px-3">
          <p className="[overflow-wrap:anywhere]">
            {automationResultsPlace(automation.bot?.resultsTo)}
          </p>
          {automation.bot?.chat ? (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('automations.botTarget.runsIn', 'Runs in')}:{' '}
              {botTargetChatTitle(automation.bot.chat)}
            </p>
          ) : null}
        </div>
      )}
    </DetailSection>
  )
}
