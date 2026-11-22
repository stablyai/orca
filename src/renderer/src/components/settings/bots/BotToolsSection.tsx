import React, { useId, useState } from 'react'
import { ChevronDown, Plus, Puzzle, Trash2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BotConnectorRowFrame, ConnectorStatus } from '@/components/bots/BotConnectorRow'
import { AddBotToolDialog } from '@/components/bots/AddBotToolDialog'
import { BotToolFinishSignIn } from '@/components/bots/BotToolFinishSignIn'
import { botToolSubtitle, botToolTitle } from '../../../../../shared/bots/bot-tool-labels'
import { botToolErrorMessage, removeBotTool } from '@/components/bots/bot-tools-client'
import { useBotToolSignInAction } from '@/components/bots/bot-tool-sign-in-action'
import { useBotTools } from '@/components/bots/bot-tool-checks'
import { retryBotToolCheck } from '@/components/bots/bot-tools-revision'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { toolsLine } from '@/components/bots/bot-settings-row-states'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotInheritedTool, BotOwnTool, BotToolProblem } from '../../../../../shared/bot-tools'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { ComposioToolRow } from '@/components/bots/composio/ComposioToolRow'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import { COMPOSIO_SESSION_MCP_URL } from '../../../../../shared/composio/composio-apps'

function OwnToolRow(props: {
  bot: Bot
  tool: BotOwnTool
  problem: BotToolProblem | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const { bot, tool, problem } = props
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const signIn = useBotToolSignInAction(bot, tool, problem)
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action()
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  // A problem the sign-in doesn't explain: the server won't start, or the check didn't finish.
  const other = problem && problem.kind !== 'sign-in' ? problem : undefined
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotToolLogo name={tool.name} detail={tool.detail} />}
      name={botToolTitle(tool.name)}
      description={botToolSubtitle(tool)}
      status={
        other
          ? {
              label:
                other.kind === 'unconfirmed'
                  ? t('settings.bots.tools.details.unconfirmed', 'Not confirmed')
                  : t('settings.bots.tools.wontStart', 'Won’t start'),
              tone: 'attention'
            }
          : null
      }
      notice={
        signIn.line && signIn.face !== 'signed-in' ? (
          <ConnectorStatus label={signIn.line} tone="attention" checking={false} />
        ) : null
      }
      fix={
        signIn.action
          ? {
              label: signIn.action.label,
              disabled: busy || signIn.action.busy,
              onClick: signIn.action.run,
              opensRow: true
            }
          : null
      }
      trailing={null}
      defaultOpen={signIn.started}
    >
      <div className="flex items-center gap-2 pt-4">
        <p className="min-w-0 flex-1 truncate font-mono text-xs leading-5 text-muted-foreground">
          {tool.detail}
        </p>
        {other ? (
          <Button variant="ghost" size="xs" disabled={busy} onClick={retryBotToolCheck}>
            {t('settings.bots.tools.details.checkAgain', 'Check again')}
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => setEditing(true)}>
          {t('settings.bots.edit', 'Edit')}
        </Button>
        <AddBotToolDialog bot={bot} name={tool.name} open={editing} onOpenChange={setEditing} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('settings.bots.tools.remove', 'Remove')}
              disabled={busy}
              onClick={() => run(() => removeBotTool(bot, tool.name))}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('settings.bots.tools.remove', 'Remove')}</TooltipContent>
        </Tooltip>
      </div>
      {signIn.pasteBack ? <BotToolFinishSignIn bot={bot} name={tool.name} openAgain /> : null}
      {other?.detail ? (
        <p className="mt-2 font-mono text-xs leading-5 text-muted-foreground">{other.detail}</p>
      ) : null}
    </BotConnectorRowFrame>
  )
}

/** The owner's own tools, folded into one read-only row. */
function InheritedToolsRow(props: {
  agent: Bot['agent']
  tools: readonly BotInheritedTool[]
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const agent = botAgentLabel(props.agent)
  const count = props.tools.length
  return (
    <div data-state={open ? 'open' : 'closed'} className="group">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Wrench className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {open
              ? t('settings.bots.tools.fromYoursOpen', '{{count}} from your {{agent}}', {
                  count,
                  agent
                })
              : t('settings.bots.tools.fromYours', '{{count}} more from your {{agent}}', {
                  count,
                  agent
                })}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {open
              ? t('settings.bots.tools.readOnly', 'Read-only here. Change them in {{agent}}.', {
                  agent
                })
              : props.tools.map((tool) => botToolTitle(tool.name)).join(', ')}
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </button>
      <div id={panelId} hidden={!open} className="pr-4 pb-3 pl-15">
        <ul className="flex flex-col gap-0.5">
          {props.tools.map((tool) => (
            <li
              key={`${tool.plugin ? 'plugin' : 'server'}:${tool.name}`}
              className="flex h-7 items-center gap-2 text-sm"
            >
              {tool.plugin ? (
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted">
                  <Puzzle className="size-3 text-muted-foreground" />
                </span>
              ) : (
                <BotToolLogo name={tool.name} size="sm" />
              )}
              <span className="truncate">{botToolTitle(tool.name)}</span>
              {tool.plugin ? (
                <span className="text-xs text-muted-foreground">
                  {t('settings.bots.tools.plugin', 'Plugin')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function AddToolRow({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/50 text-muted-foreground">
        <Plus className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {t('settings.bots.tools.add', 'Add a tool')}
        </span>
      </span>
    </button>
  )
}

/** Settings › Bots › this bot › Tools: its own tools, then the ones it gets from its owner's agent. */
export function BotToolsSection({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { view } = useBotTools(bot)
  const [adding, setAdding] = useState(false)
  const tools = view.status === 'ready' ? view.tools : null
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.tools.title', 'Tools')}
        description={toolsLine(tools, botAgentLabel(bot.agent), intlLocale)}
      />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <ComposioToolRow bot={bot} />
        {tools
          ? tools.own
              // The Composio row above is this tool, drawn as its app catalog.
              .filter((tool) => !COMPOSIO_SESSION_MCP_URL.test(tool.detail))
              .map((tool) => (
                <OwnToolRow
                  key={tool.name}
                  bot={bot}
                  tool={tool}
                  problem={view.status === 'ready' ? view.problems[tool.name] : undefined}
                />
              ))
          : null}
        {tools && tools.inherited.length > 0 ? (
          <InheritedToolsRow agent={bot.agent} tools={tools.inherited} />
        ) : null}
        {view.status === 'error' ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">{view.message}</p>
        ) : null}
        <AddToolRow onOpen={() => setAdding(true)} />
      </div>
      <AddBotToolDialog bot={bot} open={adding} onOpenChange={setAdding} />
    </section>
  )
}
