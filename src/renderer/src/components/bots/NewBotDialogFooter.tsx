// @protected-copy scope=file
// New bot's footer: Use chat defaults on the left, Template, share-back and Create on the right.
import React, { useRef } from 'react'
import { LayoutTemplate } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { botAgentSetupOnDefaults, type BotAgentSetup } from './BotAgentLaunchPicker'
import { BotCreateButton } from './BotCreateButton'
import type { NewBotShareSource } from './sharing/new-bot-from-share'
import { NewBotShareBack } from './sharing/NewBotFromShareParts'

export function NewBotDialogFooter({
  setup,
  agentPickerShown,
  onSetupChange,
  onTemplate,
  shareSource,
  creating,
  hostBusy,
  agentFieldRef
}: {
  setup: BotAgentSetup
  /** False while the Agent field shows a placeholder; the link resets only a setup on screen. */
  agentPickerShown: boolean
  onSetupChange: (setup: BotAgentSetup, permissionPicked?: boolean) => void
  /** Offered only before anything is typed or picked, since it closes the dialog. */
  onTemplate?: () => void
  shareSource?: NewBotShareSource
  creating: boolean
  hostBusy: boolean
  /** Where focus goes after a reset while Create is disabled. */
  agentFieldRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const chatDefaults = agentPickerShown ? botAgentSetupOnDefaults(setup, true) : undefined
  const createRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogFooter
      // One row in every locale: the link gives way (ellipsis) while Back and Create keep their labels.
      className="mt-0 shrink-0 flex-nowrap [&>[data-slot=dialog-footer-actions]]:shrink-0"
      start={
        chatDefaults ? (
          // Off the Agent field and muted, so the form reads as Computer and Agent. Wrapped so the
          // footer's 13px button rule skips it and it stays caption-sized.
          <div className="flex min-w-0">
            <Button
              type="button"
              variant="link-muted"
              size="inlineText"
              className="min-w-0 shrink"
              title={t(
                'bots.new.useChatDefaultsHint',
                "Reset the agent's model, options and permissions to your chat defaults"
              )}
              disabled={creating}
              onClick={() => {
                onSetupChange(chatDefaults, true)
                // The link unmounts; keep keyboard focus off the dialog's top: Create, else the Agent picker.
                const create = createRef.current
                if (create && !create.disabled) {
                  create.focus()
                } else {
                  agentFieldRef.current?.querySelector<HTMLElement>('button')?.focus()
                }
              }}
            >
              <span className="truncate py-0.5">
                {t('bots.new.useChatDefaults', 'Use chat defaults')}
              </span>
            </Button>
          </div>
        ) : null
      }
    >
      {onTemplate && !chatDefaults ? (
        <Button type="button" variant="ghost" size="sm" onClick={onTemplate}>
          <LayoutTemplate aria-hidden />
          {t('bots.new.fromTemplate', 'Template')}
        </Button>
      ) : null}
      {shareSource ? <NewBotShareBack source={shareSource} disabled={creating} /> : null}
      <BotCreateButton
        ref={createRef}
        type="submit"
        busy={creating}
        disabled={creating || hostBusy}
      >
        {t('bots.new.create', 'Create')}
      </BotCreateButton>
    </DialogFooter>
  )
}
