import { revealInstalledAgentChoice } from './installed-agent-choice-reveal'
import { useEffect, useId, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { AgentDefaultSurface } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { normalizeAgentDefaultSurface } from '../../../../../../shared/native-chat/settings/native-chat-providers'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useImmediateMutation } from '@/hooks/useImmediateMutation'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { trackAgentDefaultSurfaceChanged } from '../../../feature-tips/feature-tip-telemetry'
import {
  ChatSurfacePreview,
  TerminalSurfacePreview
} from '../../../agent/launch-settings/AgentDefaultSurfacePreviews'
import { AGENT_DEFAULT_SURFACE_SECTION_ID } from '../agents-search'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { Button } from '../../../ui/button'
import { saveAgentDefaultSurface } from '../../../../lib/agent-session/launch/native-chat-provider-choice'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../../host-scope/use-host-setting'
import {
  agentSettingsSaveFailed,
  showKeptSurfaceNotice,
  type KeptSurfaceWriter
} from './kept-surface-notice'

/** Settings-owned notice: only while mounted, and dismissed when Settings unmounts. */
function useKeptSurfaceNotice(): (surface: AgentDefaultSurface, writer: KeptSurfaceWriter) => void {
  const id = useId()
  const mounted = useMountedRef()
  useEffect(
    () => () => {
      toast.dismiss(id)
    },
    [id]
  )
  return (surface, writer) => {
    if (mounted.current) {
      showKeptSurfaceNotice({ id, surface, writer })
    }
  }
}

function SurfaceTile({
  name,
  checked,
  pending,
  title,
  description,
  preview,
  onSelect,
  selectOnClick = false
}: {
  name: string
  checked: boolean
  pending: boolean
  title: string
  description: string
  preview: ReactNode
  onSelect: () => void
  /** Saves even the checked tile, so a server's untouched default can be confirmed as a choice. */
  selectOnClick?: boolean
}): JSX.Element {
  return (
    <label
      className={cn(
        'block min-w-0 cursor-pointer rounded-xl border p-2.5 pb-3.5 transition-[border-color,box-shadow,background-color] duration-150 motion-reduce:transition-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-ring',
        pending && 'cursor-wait opacity-60',
        checked
          ? 'border-foreground bg-card shadow-[0_0_0_1px_var(--foreground),0_4px_14px_rgb(0_0_0/0.08)]'
          : 'group border-foreground/15 bg-card/60 hover:border-foreground/40 hover:bg-card'
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={pending}
        onChange={selectOnClick ? () => {} : onSelect}
        onClick={selectOnClick ? onSelect : undefined}
        className="sr-only"
      />
      <div aria-hidden className="h-[292px] rounded-lg bg-muted/70 p-3">
        {preview}
      </div>
      <div className="mt-3 flex items-center gap-2 px-1">
        <span
          className={cn(
            'flex size-[18px] shrink-0 items-center justify-center rounded-full border',
            checked
              ? 'border-foreground bg-foreground text-background'
              : 'border-foreground/30 group-hover:border-foreground'
          )}
        >
          {pending ? (
            <LoadingSpinner className="size-3" />
          ) : checked ? (
            <Check className="size-3" strokeWidth={3} />
          ) : null}
        </span>
        <span className="text-[15px] font-semibold">{title}</span>
      </div>
      <p className="mt-0.5 pr-1 pl-[34px] text-[12.5px] leading-[18px] text-muted-foreground">
        {description}
      </p>
    </label>
  )
}

/** The picked host's default surface; on This computer, agents set on their own Installed row keep their choice. */
export function AgentDefaultSurfaceSection({
  settings,
  hostScope = LOCAL_SETTINGS_HOST_SCOPE,
  presentation = 'tiles'
}: {
  settings: GlobalSettings
  /** A server's value only decides the agents that server starts itself. */
  hostScope?: SettingsHostScope
  presentation?: 'tiles' | 'switch'
}): JSX.Element {
  const t = useTranslate()
  const name = useId()
  const notify = useKeptSurfaceNotice()
  const updateSettings = useAppStore((s) => s.updateSettingsOrThrow)
  const mutation = useImmediateMutation()
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const hostSurface = useHostSetting({
    owner: hostScope.target,
    settingKey: 'agentDefaultSurface',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  const onServer = hostScope.target.kind === 'environment'
  const serverReady = hostScope.available && hostSurface.setting.state === 'ready'
  const pending = mutation.isPending('default-surface') || (onServer && !serverReady)
  const surface = onServer
    ? hostSurface.setting.state === 'ready'
      ? hostSurface.setting.value
      : null
    : normalizeAgentDefaultSurface(settings.agentDefaultSurface)
  const title = t('settings.agents.defaultSurfaceTitle', 'Open agents as')
  const choose = (next: AgentDefaultSurface): void => {
    if (onServer) {
      void hostSurface.update(next)
      return
    }
    const writer = { fallbackSettings: settings, updateSettings }
    void mutation.run('default-surface', {
      mutate: () => saveAgentDefaultSurface({ surface: next, ...writer }),
      onSuccess: () => {
        trackAgentDefaultSurfaceChanged({
          from_mode: normalizeAgentDefaultSurface(settings.agentDefaultSurface),
          to_mode: next,
          source: 'settings'
        })
        notify(next, writer)
      },
      onError: agentSettingsSaveFailed
    })
  }
  if (presentation === 'switch') {
    return (
      <SettingsGroup>
        <SettingsRow
          label={
            <span className="text-lg font-semibold">
              {surface === 'chat'
                ? t('settings.chat.launch.on', 'Chat UI is on')
                : t('settings.chat.launch.off', 'Chat UI is off')}
            </span>
          }
          description={
            surface === 'chat'
              ? t(
                  'settings.chat.launch.chatDescription',
                  'New agents will launch in chat mode by default.'
                )
              : t(
                  'settings.chat.launch.cliDescription',
                  'New agents will launch as CLI by default.'
                )
          }
          control={
            <Button
              variant={surface === 'chat' ? 'outline' : 'default'}
              disabled={pending}
              onClick={() => choose(surface === 'chat' ? 'terminal' : 'chat')}
            >
              {surface === 'chat'
                ? t('settings.chat.launch.turnOff', 'Turn off')
                : t('settings.chat.launch.turnOn', 'Turn on')}
            </Button>
          }
        />
      </SettingsGroup>
    )
  }
  return (
    <div id={AGENT_DEFAULT_SURFACE_SECTION_ID} className="@container scroll-mt-8">
      <SettingsGroup
        title={title}
        description={
          !onServer
            ? t(
                'settings.agents.defaultSurfaceDescription',
                'The default for agents on this computer.'
              )
            : hostSurface.setting.state === 'unsupported'
              ? getHostSettingUnsupportedNote(hostLabel, t)
              : t(
                  'settings.agents.defaultSurfaceServerDescription',
                  "The default for agents {{host}} starts itself, such as from its CLI or orchestration workers. Agents you open from this computer follow This computer's choice.",
                  { host: hostLabel }
                )
        }
        bodyClassName="py-4"
      >
        <div
          role="radiogroup"
          aria-label={title}
          aria-busy={pending}
          className="grid gap-3.5 @2xl:grid-cols-2"
        >
          <SurfaceTile
            name={name}
            pending={pending}
            checked={surface === 'chat'}
            title={t('settings.agents.defaultOpensAsChat', 'Chat')}
            description={t(
              'settings.agents.defaultSurfaceChatDescription',
              'Rich messages, visuals and images.'
            )}
            preview={<ChatSurfacePreview />}
            onSelect={() => choose('chat')}
            selectOnClick={onServer}
          />
          <SurfaceTile
            name={name}
            pending={pending}
            checked={surface === 'terminal'}
            title={t('settings.agents.defaultSurfaceTerminal', 'Terminal')}
            description={t(
              'settings.agents.defaultSurfaceTerminalDescription',
              'Each agent’s own CLI.'
            )}
            preview={<TerminalSurfacePreview settings={settings} />}
            onSelect={() => choose('terminal')}
            selectOnClick={onServer}
          />
        </div>
        {onServer ? null : (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={revealInstalledAgentChoice}
              className="inline-flex items-center gap-0.5 rounded-sm text-[13px] font-medium underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t('settings.agents.defaultSurfacePerAgent', 'Choose per agent')}
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        )}
      </SettingsGroup>
    </div>
  )
}
