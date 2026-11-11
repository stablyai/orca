import type { AgentSessionHook } from '../../../../../shared/agent-session/agent-session-hooks'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function NativeChatHookReview({
  hook,
  busy,
  onTrust
}: {
  hook: AgentSessionHook
  busy: boolean
  onTrust: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const reviewable =
    hook.handlerType === 'command' &&
    Boolean(hook.command) &&
    !hook.isManaged &&
    (hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified')
  const status =
    hook.trustStatus === 'trusted'
      ? t('components.native-chat.hooks.trusted', 'Trusted')
      : hook.trustStatus === 'managed' || hook.isManaged
        ? t('components.native-chat.hooks.managed', 'Managed')
        : hook.trustStatus === 'modified'
          ? t('components.native-chat.hooks.modified', 'Changed since last trusted')
          : t('components.native-chat.hooks.untrusted', 'Needs review')
  return (
    <section className="space-y-3 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{hook.eventName}</h3>
        <span className="text-xs text-muted-foreground">{status}</span>
      </div>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">{t('components.native-chat.hooks.source', 'Source: ')}</dt>
          <dd className="inline break-all">
            {hook.source} · {hook.sourcePath}
          </dd>
        </div>
        {hook.matcher ? (
          <div>
            <dt className="inline">{t('components.native-chat.hooks.matcher', 'Matcher: ')}</dt>
            <dd className="inline break-all">{hook.matcher}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline">
            {t('components.native-chat.hooks.timeout', 'Timeout (seconds): ')}
          </dt>
          <dd className="inline">{hook.timeoutSec}</dd>
        </div>
        <div>
          <dt className="inline">{t('components.native-chat.hooks.execution', 'Execution: ')}</dt>
          <dd className="inline">
            {hook.async
              ? t('components.native-chat.hooks.async', 'Background')
              : t('components.native-chat.hooks.sync', 'Foreground')}
          </dd>
        </div>
      </dl>
      {hook.command !== undefined ? (
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-chat-code text-foreground">
          {hook.command}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.native-chat.hooks.unsupportedHandler',
            'Review this hook type in Codex; its full contents are not available here.'
          )}
        </p>
      )}
      {!hook.enabled ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.native-chat.hooks.disabled',
            'Disabled. Trusting this hook will not enable it.'
          )}
        </p>
      ) : null}
      {reviewable ? (
        <Button type="button" size="sm" disabled={busy} onClick={onTrust}>
          {t('components.native-chat.hooks.trust', 'Trust this hook')}
        </Button>
      ) : null}
    </section>
  )
}
