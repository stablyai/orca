// A server page's own details, edited in place like an agent's launch fields: Launch (command, its
// arguments and environment) for a command server, Connection (URL and headers) for an HTTP one
// Orca doesn't sign in to. A change saves when focus leaves the card.
import React, { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolSecretRows } from '@/components/bots/BotToolSecretRows'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  botToolDraftError,
  botToolDraftInput,
  draftFromServer,
  type BotToolDraft
} from '../../../../../shared/bots/bot-tool-draft'
import {
  readMcpServerDetails,
  setMcpServerSharedProcess,
  updateMcpServer,
  type McpServerDetails,
  type McpServerView
} from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import { formatMcpLaunchArgs, parseMcpLaunchArgs } from './mcp-server-launch-args'
import { mcpServerTitle } from './mcp-server-words'
import { showMcpServerChangeToast } from './mcp-server-change-toast'

function Field({
  label,
  children
}: {
  label: string
  children: (id: string) => React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-settings-detail text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  )
}

export function McpServerLaunchGroup({
  target,
  server,
  platform,
  readOnly
}: {
  target: RuntimeClientTarget
  server: McpServerView
  platform: NodeJS.Platform
  /** A plugin's server: its details are the plugin's. */
  readOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const [details, setDetails] = useState<McpServerDetails | null>(null)
  const [draft, setDraft] = useState<BotToolDraft | null>(null)
  const [argsLine, setArgsLine] = useState('')
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const { id } = server
  useEffect(() => {
    let live = true
    void readMcpServerDetails(target, id).then(
      (read) => {
        if (live) {
          setDetails(read)
          const next = draftFromServer(read.server)
          setDraft(next)
          setArgsLine(
            formatMcpLaunchArgs(
              next.args.map((arg) => arg.value),
              platform
            ) ?? ''
          )
        }
      },
      (error: unknown) => toast.error(botToolErrorMessage(error))
    )
    return () => {
      live = false
    }
    // A save elsewhere changes the row; read the details again with it.
  }, [target, id, platform, revision, server.detail])

  if (!details || !draft) {
    return null
  }
  const command = draft.mode === 'command'
  const args = command ? parseMcpLaunchArgs(argsLine, platform) : []
  // Arguments that one line can't show stay as they are; the line is read-only then.
  const argsFixed =
    command &&
    formatMcpLaunchArgs(
      draft.args.map((arg) => arg.value),
      platform
    ) === null
  const withArgs = (base: BotToolDraft): BotToolDraft =>
    command && args && !argsFixed
      ? { ...base, args: args.map((value, index) => ({ id: String(index), value })) }
      : base
  const save = (base: BotToolDraft = draft): void => {
    const next = withArgs(base)
    const input = botToolDraftInput(next)
    const saved = botToolDraftInput(draftFromServer(details.server))
    if (saving || (command && !args) || JSON.stringify(input) === JSON.stringify(saved)) {
      return
    }
    const invalid = botToolDraftError(next, platform, t, details)
    if (invalid) {
      toast.error(invalid)
      return
    }
    setSaving(true)
    void updateMcpServer(target, id, details.version, input)
      .then(() => {
        // Read the saved details back: saved values come back masked.
        setRevision((value) => value + 1)
        return showMcpServerChangeToast(
          target,
          t('settings.mcpServers.toast.saved', '{{name}} saved', {
            name: mcpServerTitle(server.name)
          })
        )
      })
      .catch((error: unknown) => {
        const stale = error instanceof RuntimeRpcCallError && error.code === 'mcp_server_stale'
        // Only a stale edit is replaced by the server as it is now; any other failure keeps the typing.
        if (stale) {
          setRevision((value) => value + 1)
        }
        toast.error(
          stale
            ? t(
                'settings.mcpServers.stale',
                'This server changed elsewhere. Showing it as it is now.'
              )
            : botToolErrorMessage(error)
        )
      })
      .finally(() => setSaving(false))
  }

  // A removed row saves at once: its Remove button goes with it, so focus never leaves the card.
  const change = (next: BotToolDraft, removed: boolean): void => {
    setDraft(next)
    if (removed) {
      save(next)
    }
  }

  return (
    <SettingsGroup
      title={
        command
          ? t('settings.mcpServers.launch.title', 'Launch')
          : t('settings.mcpServers.connection.title', 'Connection')
      }
    >
      <fieldset
        disabled={readOnly || saving}
        className="space-y-3 py-4"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            save()
          }
        }}
      >
        {command ? (
          <>
            <Field label={t('settings.mcpServers.launch.command', 'Command')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  variant="code"
                  className="h-7"
                  value={draft.command}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('settings.mcpServers.launch.args', 'Arguments')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  variant="code"
                  className="h-7"
                  readOnly={argsFixed}
                  aria-invalid={args === null}
                  value={argsFixed ? draft.args.map((arg) => arg.value).join(' ') : argsLine}
                  onChange={(event) => setArgsLine(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('settings.mcpServers.launch.env', 'Environment')}>
              {() => (
                <BotToolSecretRows
                  kind="variable"
                  dense
                  locked
                  rows={draft.env}
                  onChange={(env) => change({ ...draft, env }, env.length < draft.env.length)}
                />
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label={t('settings.mcpServers.connection.url', 'URL')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  variant="code"
                  className="h-7"
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('settings.mcpServers.connection.headers', 'Headers')}>
              {() => (
                <BotToolSecretRows
                  kind="header"
                  dense
                  locked
                  rows={draft.headers}
                  onChange={(headers) =>
                    change({ ...draft, headers }, headers.length < draft.headers.length)
                  }
                />
              )}
            </Field>
          </>
        )}
      </fieldset>
      {command ? (
        <SettingsGroupDisclosure flush>
          <div data-settings-row="" className="flex items-center gap-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                {t('settings.mcpServers.shared.title', 'Share one process across agents')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(
                  'settings.mcpServers.shared.line',
                  'Uses less memory. The server runs outside the workspace folder.'
                )}
              </span>
            </span>
            <Switch
              checked={server.sharedProcess}
              aria-label={t('settings.mcpServers.shared.title', 'Share one process across agents')}
              onCheckedChange={(enabled) =>
                void setMcpServerSharedProcess(target, id, enabled).then(
                  () =>
                    showMcpServerChangeToast(
                      target,
                      enabled
                        ? t('settings.mcpServers.toast.sharedOn', '{{name}} shares one process', {
                            name: mcpServerTitle(server.name)
                          })
                        : t(
                            'settings.mcpServers.toast.sharedOff',
                            '{{name}} runs once per session',
                            { name: mcpServerTitle(server.name) }
                          )
                    ),
                  (error: unknown) => toast.error(botToolErrorMessage(error))
                )
              }
            />
          </div>
        </SettingsGroupDisclosure>
      ) : null}
    </SettingsGroup>
  )
}
