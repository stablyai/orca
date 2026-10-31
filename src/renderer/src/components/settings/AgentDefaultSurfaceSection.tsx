import { useEffect, useId, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentDefaultSurface } from '../../../../shared/native-chat/native-chat-appearance-settings'
import { normalizeAgentDefaultSurface } from '../../../../shared/native-chat/native-chat-providers'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useImmediateMutation } from '@/hooks/useImmediateMutation'
import { useMountedRef } from '@/hooks/useMountedRef'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { ChatSurfacePreview, TerminalSurfacePreview } from './AgentDefaultSurfacePreviews'
import { AGENT_DEFAULT_SURFACE_SECTION_ID, AGENTS_INSTALLED_SECTION_ID } from './agents-search'
import {
  agentsKeepingOwnSurface,
  followAgentDefaultSurface,
  saveAgentDefaultSurface
} from './native-chat-provider-choice'

function saveFailed(): void {
  toast.error(
    translate('settings.agents.localSaveFailed', 'Agent settings could not be saved. Try again.')
  )
}

type Writer = {
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** After the default changes, names the agents set for themselves to the other surface. */
function useKeptSurfaceNotice(): (surface: AgentDefaultSurface, writer: Writer) => void {
  const id = useId()
  const mounted = useMountedRef()
  useEffect(
    () => () => {
      toast.dismiss(id)
    },
    [id]
  )
  return (surface, writer) => {
    const latest = useAppStore.getState().settings ?? writer.fallbackSettings
    // A failed or superseded write leaves nothing to report.
    if (!mounted.current || normalizeAgentDefaultSurface(latest.agentDefaultSurface) !== surface) {
      return
    }
    const kept = agentsKeepingOwnSurface(latest, surface)
    if (kept.length === 0) {
      toast.dismiss(id)
      return
    }
    const values = {
      agents: new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
        kept.map((agent) => getAgentLabel(agent))
      ),
      count: kept.length
    }
    const chat = surface === 'chat'
    toast.success(
      chat
        ? translate('settings.agents.defaultSurfaceNowChat', 'Agents now open as chats')
        : translate('settings.agents.defaultSurfaceNowTerminal', 'Agents now open in the terminal'),
      {
        id,
        description: chat
          ? translate(
              'settings.agents.defaultSurfaceKeptTerminal',
              '{{agents}} stay in the terminal, as you set.',
              {
                ...values,
                count: values.count,
                defaultValue_one: '{{agents}} stays in the terminal, as you set.'
              }
            )
          : translate(
              'settings.agents.defaultSurfaceKeptChat',
              '{{agents}} stay as chats, as you set.',
              {
                ...values,
                count: values.count,
                defaultValue_one: '{{agents}} stays as a chat, as you set.'
              }
            ),
        action: {
          label: chat
            ? translate('settings.agents.defaultSurfaceSetAllChat', 'Set all to Chat')
            : translate('settings.agents.defaultSurfaceSetAllTerminal', 'Set all to Terminal'),
          onClick: () =>
            void followAgentDefaultSurface({ agents: kept, surface, ...writer }).catch(saveFailed)
        }
      }
    )
  }
}

function SurfaceTile({
  name,
  checked,
  pending,
  title,
  description,
  preview,
  onSelect
}: {
  name: string
  checked: boolean
  pending: boolean
  title: string
  description: string
  preview: ReactNode
  onSelect: () => void
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
        onChange={onSelect}
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

/** This computer's default surface; agents set on their own Installed row keep their choice. */
export function AgentDefaultSurfaceSection({
  settings
}: {
  settings: GlobalSettings
}): JSX.Element {
  const name = useId()
  const notify = useKeptSurfaceNotice()
  const updateSettings = useAppStore((s) => s.updateSettingsOrThrow)
  const mutation = useImmediateMutation()
  const pending = mutation.isPending('default-surface')
  const surface = normalizeAgentDefaultSurface(settings.agentDefaultSurface)
  const title = translate('settings.agents.defaultSurfaceTitle', 'Open agents as')
  const choose = (next: AgentDefaultSurface): void => {
    const writer = { fallbackSettings: settings, updateSettings }
    void mutation.run('default-surface', {
      mutate: () => saveAgentDefaultSurface({ surface: next, ...writer }),
      onSuccess: () => notify(next, writer),
      onError: saveFailed
    })
  }
  const showInstalledList = (): void => {
    const list = document.getElementById(AGENTS_INSTALLED_SECTION_ID)
    list?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: 'start' })
    list?.focus({ preventScroll: true })
  }
  return (
    <section id={AGENT_DEFAULT_SURFACE_SECTION_ID} className="@container scroll-mt-8">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {translate(
          'settings.agents.defaultSurfaceDescription',
          'The default for agents on this computer.'
        )}
      </p>
      <div
        role="radiogroup"
        aria-label={title}
        aria-busy={pending}
        className="mt-3.5 grid gap-3.5 @3xl:grid-cols-2"
      >
        <SurfaceTile
          name={name}
          pending={pending}
          checked={surface === 'chat'}
          title={translate('settings.agents.defaultOpensAsChat', 'Chat')}
          description={translate(
            'settings.agents.defaultSurfaceChatDescription',
            'Rich messages, visuals and images.'
          )}
          preview={<ChatSurfacePreview />}
          onSelect={() => choose('chat')}
        />
        <SurfaceTile
          name={name}
          pending={pending}
          checked={surface === 'terminal'}
          title={translate('settings.agents.defaultSurfaceTerminal', 'Terminal')}
          description={translate(
            'settings.agents.defaultSurfaceTerminalDescription',
            'Each agent’s own CLI.'
          )}
          preview={<TerminalSurfacePreview settings={settings} />}
          onSelect={() => choose('terminal')}
        />
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={showInstalledList}
          className="inline-flex items-center gap-0.5 rounded-sm text-[13px] font-medium underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {translate('settings.agents.defaultSurfacePerAgent', 'Choose per agent')}
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </section>
  )
}
