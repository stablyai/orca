import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { AutomationPromptDisclosure } from '../automations/details/AutomationPromptDisclosure'

export function BotAutomationInstructions({
  automation,
  botName,
  askInChat
}: {
  automation: Automation
  botName: string
  askInChat: ((sentence: string) => Promise<boolean>) | null
}): React.JSX.Element {
  const t = useTranslate()
  const [failed, setFailed] = useState(false)
  const retry = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (failed) {
      retry.current?.focus()
    }
  }, [failed])
  const open = (): void => {
    setFailed(false)
    if (!askInChat) {
      return
    }
    void askInChat(
      t('automations.botEvents.editDraft', 'Change the automation “{{name}}”: ', {
        name: automation.name
      })
    )
      .then((opened) => setFailed(!opened))
      .catch(() => setFailed(true))
  }
  return (
    <>
      <AutomationPromptDisclosure
        key={`${automation.id}:${automation.prompt}`}
        prompt={automation.prompt}
        title={t('bots.automationPanel.instructions', 'Instructions')}
        copyNoun="instructions"
        actions={
          askInChat ? (
            <button
              type="button"
              className="min-h-6 rounded-sm px-1.5 py-0.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={open}
            >
              {t('automations.botEvents.editInChat', 'Edit in chat')}
            </button>
          ) : null
        }
      />
      {failed ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 px-1 text-xs text-destructive">
          {t('bots.automationPanel.chatFailed', "Couldn't open {{name}}'s chat.", {
            name: botName
          })}
          <button ref={retry} type="button" className="min-h-6 underline" onClick={open}>
            {t('bots.automationPanel.retry', 'Retry')}
          </button>
        </p>
      ) : null}
    </>
  )
}
