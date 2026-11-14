import { Bot, GitFork } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { NativeChatWorktreeForkDialog } from '../use-native-chat-fork'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'
import { runNativeChatForkWindow } from './native-chat-fork-window-run'
import { useNativeChatForkWindowState } from './use-native-chat-fork-window-state'
import { NativeChatForkWindowTargetFields } from './NativeChatForkWindowTargetFields'
import { NativeChatForkWindowWorktreeFields } from './NativeChatForkWindowWorktreeFields'

type WindowProps = {
  dialog: NativeChatWorktreeForkDialog | null
  source: NativeChatForkWindowSource | null
}

/** The one Fork window: host, workspace, agent and run mode, each with a default Enter confirms. */
export function NativeChatForkWindowHost({
  dialog,
  source
}: WindowProps): React.JSX.Element | null {
  // Keyed per opening, so each one starts from the defaults, the next free name and an empty task.
  return dialog && source ? (
    <ForkWindow key={`${dialog.throughItemId}:${dialog.mode}`} dialog={dialog} source={source} />
  ) : null
}

/** Holds the busy flag across `work`; a second press while it runs does nothing. */
async function runWithBusyFlag(
  busyRef: { current: boolean },
  setBusy: (busy: boolean) => void,
  work: () => Promise<void>
): Promise<void> {
  if (busyRef.current) {
    return
  }
  busyRef.current = true
  setBusy(true)
  try {
    await work()
  } finally {
    busyRef.current = false
    setBusy(false)
  }
}

function ForkWindow({
  dialog,
  source
}: {
  dialog: NativeChatWorktreeForkDialog
  source: NativeChatForkWindowSource
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const state = useNativeChatForkWindowState(source, dialog.mode)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  // A pane that unmounts mid-copy stops relaying; a host-side transfer expires on its own.
  useEffect(() => () => abortRef.current?.abort(), [])
  const subagent = state.runAs === 'subagent'
  const fork = (): void => {
    if (!state.ready) {
      return
    }
    const selection = state.selection(dialog.throughItemId, dialog.draft)
    void runWithBusyFlag(busyRef, setBusy, async () => {
      const abort = new AbortController()
      abortRef.current = abort
      if (await runNativeChatForkWindow(source, selection, abort.signal)) {
        dialog.close()
      }
    })
  }
  const agentLabel = getAgentLabel(state.agent)
  const description =
    state.route === 'recap'
      ? t(
          'components.native-chat.fork.window.recapDescription',
          '{{agent}} starts with a recap of this chat, up to this point, as its first message. The recap is written here, without asking any model. This chat stays as it is.',
          { agent: agentLabel }
        )
      : state.route === 'other-host'
        ? t(
            'components.native-chat.fork.window.hostDescription',
            '{{host}} opens an exact copy of this chat, up to this point, in the workspace you choose. This chat stays as it is.',
            { host: state.host.label }
          )
        : t(
            'components.native-chat.fork.window.description',
            'A copy of this chat, up to this point, opens where you choose. This chat stays as it is.'
          )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) {
          dialog.close()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        onOpenAutoFocus={(event) => {
          // Enter confirms the defaults.
          event.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            fork()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog.draft
                ? t('components.native-chat.fork.window.titleFromMessage', 'Fork from here')
                : t('components.native-chat.fork.window.title', 'Fork chat')}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {source.usageLimited && state.agent !== source.agent ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.native-chat.fork.window.usageLimited',
                '{{source}} has reached its usage limit, so {{agent}} is suggested.',
                { source: getAgentLabel(source.agent), agent: agentLabel }
              )}
            </p>
          ) : null}
          <NativeChatForkWindowTargetFields
            id={id}
            busy={busy}
            hosts={state.hostChoices}
            hostId={state.host.id}
            onHostChange={state.selectHost}
            workspaceKinds={state.workspaceKinds}
            workspace={state.workspace}
            worktrees={state.worktrees}
            onWorkspaceChange={state.setWorkspace}
            agents={state.agents}
            agent={state.agent}
            detectingAgents={state.detecting}
            otherHostsNeedAnotherAgent={state.otherHostsNeedAnotherAgent}
            onAgentChange={state.setAgent}
            runAs={state.runAs}
            runAsShown={source.subagentOffered}
            subagentAllowed={state.subagentAllowed}
            onRunAsChange={state.setRunAs}
          />
          {state.workspace.kind === 'new-worktree' ? (
            <NativeChatForkWindowWorktreeFields
              id={id}
              name={state.worktree.name}
              slug={state.worktree.slug}
              base={state.worktree.base}
              branch={state.worktree.branch}
              busy={busy}
              onNameChange={state.worktree.setName}
              onBaseChange={state.worktree.setBase}
            />
          ) : null}
          {subagent ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-task`}>
                {t('components.native-chat.fork.subagent.taskLabel', 'Task')}
              </Label>
              <Textarea
                id={`${id}-task`}
                value={state.task}
                disabled={busy}
                rows={4}
                placeholder={t(
                  'components.native-chat.fork.subagent.taskPlaceholder',
                  'What should the subagent do?'
                )}
                onChange={(event) => state.setTask(event.target.value)}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={dialog.close}>
              {t('components.native-chat.fork.worktree.cancel', 'Cancel')}
            </Button>
            <Button ref={confirmRef} type="submit" disabled={busy || !state.ready}>
              {subagent ? <Bot className="size-4" /> : <GitFork className="size-4" />}
              {busy
                ? t('components.native-chat.fork.window.forking', 'Forking…')
                : subagent
                  ? t('components.native-chat.fork.subagent.confirm', 'Start subagent')
                  : t('components.native-chat.fork.worktree.confirm', 'Fork')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
