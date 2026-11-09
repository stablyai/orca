import { useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { useAppStore } from '@/store'
import type { ActivePluginCommand } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { Button } from '../../ui/button'

const RESULT_PREVIEW_LIMIT = 200

/** Worker results cross IPC as plain data, so JSON is a faithful preview; anything else is in Logs. */
function serializeResult(result: unknown): string | undefined {
  if (typeof result === 'string') {
    return result.trim()
  }
  try {
    return JSON.stringify(result)
  } catch {
    return undefined
  }
}

function resultPreview(result: unknown): string | null {
  const text = result === null || result === undefined ? '' : (serializeResult(result) ?? '')
  if (text === '') {
    return null
  }
  return text.length > RESULT_PREVIEW_LIMIT ? `${text.slice(0, RESULT_PREVIEW_LIMIT)}…` : text
}

/** Runs one plugin command the same way the palette does, and says what happened. Built-in
 *  actions leave Settings first, since they act on the app behind it. */
export function PluginContributionActionCommand({
  command,
  unavailableReason
}: {
  command: ActivePluginCommand
  /** Set when the command can't run right now; the button stays visible but off. */
  unavailableReason: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const [running, setRunning] = useState(false)
  const run = async (): Promise<void> => {
    setRunning(true)
    if (command.handler.type === 'built-in') {
      // Why sync: built-in actions act on the app view, and their dispatcher reads it only after
      // the closed Settings page commits.
      flushSync(() => useAppStore.getState().closeSettingsPage())
    }
    try {
      const result = await executePluginCommand(command, 'plugin-palette')
      const preview = resultPreview(result)
      toast.success(
        t('auto.components.settings.PluginContributionActionCommand.ran', 'Ran {{value0}}', {
          value0: command.title
        }),
        {
          description:
            preview ??
            (command.handler.type === 'worker'
              ? t(
                  'auto.components.settings.PluginContributionActionCommand.seeLogs',
                  'See Logs below'
                )
              : undefined)
        }
      )
    } catch (cause: unknown) {
      toast.error(
        t('auto.components.settings.PluginContributionActionCommand.failed', '{{value0}} failed', {
          value0: command.title
        }),
        { description: cause instanceof Error ? cause.message : String(cause) }
      )
    } finally {
      setRunning(false)
    }
  }
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={running || unavailableReason !== null}
      title={unavailableReason ?? undefined}
      aria-label={t(
        'auto.components.settings.PluginContributionActionCommand.runName',
        'Run {{value0}}',
        { value0: command.title }
      )}
      onClick={() => void run()}
    >
      {t('auto.components.settings.PluginContributionActionCommand.run', 'Run')}
    </Button>
  )
}
