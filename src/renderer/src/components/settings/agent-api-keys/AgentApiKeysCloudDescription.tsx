import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

/** Agent API keys never reach Orca Cloud hosts; the pane says so and points at Cloud secrets. */
export function AgentApiKeysCloudDescription({
  onOpenCloudSecrets
}: {
  onOpenCloudSecrets: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Trans
      i18n={i18n}
      defaults={t(
        'settings.agentApiKeys.descriptionCloudSecretsLink',
        'Keys here work on this computer and your SSH and paired hosts. To use a key in cloud workspaces, save it to your Orca account in <secrets>Cloud secrets</secrets>.'
      )}
      components={{
        // Not <link>: the Trans parser treats HTML void tag names as self-closing.
        secrets: (
          <button
            type="button"
            className="cursor-pointer rounded-sm text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
            onClick={onOpenCloudSecrets}
          />
        )
      }}
    />
  )
}
