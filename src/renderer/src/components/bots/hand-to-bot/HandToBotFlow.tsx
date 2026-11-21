import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
// Hand to bot…: pick a bot (or make one) for a workspace and, optionally, say what it should do. The
// workspace moves under the bot's home and its agents keep running as the bot's workers.
import { botRefKey, isSameBot } from '@/lib/bot-hosts'
import React, { useMemo, useRef, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItemSlot } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { takeOverWorkspace, useBots } from '@/lib/bot-catalog'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { sortBotsBySidebarOrder } from '../../../../../shared/bots/bot-homes'
import { BOT_TAKE_OVER_GOAL_MAX, type BotTakeOver } from '../../../../../shared/bots/bot-take-over'
import type { Bot } from '../../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../../../../shared/worktree/types'
import { BotAvatar } from '../BotAvatar'
import { BotCreateButton } from '../BotCreateButton'
import { BotPickFilter, BotPickRow, BotPickRows, FILTER_FROM, filterByName } from '../BotPickList'
import { NewBotDialog } from '../NewBotDialog'
import { openBotSession } from '../bot-session-open'
import { botErrorMessage } from '../bot-presentation'
import { botOfFolders, selectFolderAncestors } from '../use-worktree-bot'
import { useBotPurposes } from '../use-bot-purposes'
import { closeHandToBot, type HandToBotRequest } from './hand-to-bot-open'
import {
  botHomeParentFor,
  handOverWorkspace,
  moveUnderParent,
  placementOf,
  restorePlacement,
  suggestedBotAgent,
  suggestedBotName,
  suggestedBotPurpose
} from './hand-to-bot-workspace'

const NEW_BOT_TILE =
  'flex size-7 items-center justify-center rounded-lg border border-dashed border-input text-muted-foreground'

export function HandToBotFlow({
  request
}: {
  request: HandToBotRequest
}): React.JSX.Element | null {
  const { worktree } = request
  const t = useTranslate()
  // 'made': the new bot exists and takes the workspace over; the picker returns only if that fails.
  const [step, setStep] = useState<'pick' | 'new' | 'made'>('pick')
  const [goal, setGoal] = useState('')
  // Host and id: the same id can name a bot on this computer and one on the workspace's server.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [popped, setPopped] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // A bot made here for this workspace: a retry tells it in its Home.
  const [madeBotKey, setMadeBotKey] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const workspaceHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktree.id))
  const listed = useBots()
  // This computer's bots can take a workspace anywhere; a server's bot only one on its own server.
  const bots = useMemo(
    () =>
      sortBotsBySidebarOrder(
        listed.filter(
          (bot) => bot.hostId === LOCAL_EXECUTION_HOST_ID || bot.hostId === workspaceHostId
        )
      ),
    [listed, workspaceHostId]
  )
  // A bot made here may go where the listed ones may: this computer, or the workspace's own server.
  const newBotHosts = useMemo(
    () => [...new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID, workspaceHostId])],
    [workspaceHostId]
  )
  const purposes = useBotPurposes()
  const folders = useAppStoreWithHostStatuses((s, statuses) =>
    selectFolderAncestors(s, statuses, worktree)
  )
  const owner = botOfFolders(folders, bots)
  const agents = useWorktreeAgentRows(worktree.id).filter((row) => row.rowSource !== 'subagent')
  const takeOver = useTakeOver(
    worktree,
    agents.map((row) => row.agentType)
  )
  const picked = bots.find((bot) => botRefKey(bot) === pickedKey) ?? null
  const shown = filterByName(bots, query, (bot) => bot.name)
  const name = worktree.displayName

  /** Moves the workspace, then tells the bot in `chat`. When either fails the picker stays open on
   *  the reason, with the workspace where it was, so the owner can try again. */
  const handOver = async (bot: Bot, chat: 'home' | 'new'): Promise<boolean> => {
    setFailure(null)
    const home = botHomeParentFor(worktree, bot)
    if (!home) {
      setFailure(
        t('bots.handToBot.cantMove', "{{name}} can't move under {{bot}} from here.", {
          name,
          bot: bot.name
        })
      )
      return false
    }
    const before = placementOf(worktree)
    const trimmed = goal.trim()
    const outcome = await handOverWorkspace({
      move: () => moveUnderParent(worktree, home),
      notify: () =>
        takeOverWorkspace(bot, {
          chat,
          takeOver: { ...takeOver, ...(trimmed ? { goal: trimmed } : {}) }
        }),
      restore: () => restorePlacement(worktree, before, folderWorkspaceKey(bot.folderWorkspaceId))
    })
    if (outcome.ok) {
      if (chat === 'new') {
        openBotSession(bot, outcome.sessionId)
      }
      return true
    }
    const reason = botErrorMessage(outcome.error)
    setFailure(
      outcome.stage === 'move'
        ? reason
        : outcome.placement === 'restored'
          ? t('bots.handToBot.putBack', '{{reason}} {{name}} stayed where it was.', {
              reason,
              name
            })
          : outcome.placement === 'moved-since'
            ? t('bots.handToBot.movedSince', '{{reason}} {{name}} stays where you moved it.', {
                reason,
                name
              })
            : t(
                'bots.handToBot.leftMoved',
                '{{reason}} {{name}} is under {{bot}} now; move it back from its menu.',
                { reason, name, bot: bot.name }
              )
    )
    return false
  }

  const submit = async (): Promise<void> => {
    if (!picked || busy) {
      return
    }
    setBusy(true)
    // A bot made here hears of it in its Home, as on the first try.
    const done = await handOver(picked, botRefKey(picked) === madeBotKey ? 'home' : 'new')
    setBusy(false)
    if (done) {
      closeHandToBot()
    }
  }

  if (step === 'new') {
    return (
      <NewBotDialog
        open
        // Closing it comes back here; creating the bot does only when the hand-over fails, with its reason.
        onOpenChange={(open, made) => {
          if (!open) {
            setStep(made ? 'made' : 'pick')
          }
        }}
        initialName={suggestedBotName(name)}
        initialPurpose={suggestedBotPurpose(worktree)}
        initialAgent={suggestedBotAgent(agents.map((row) => row.agentType))}
        takingOver
        hosts={newBotHosts}
        origin={t(
          'bots.handToBot.newBotOrigin',
          'From {{name}}. It takes the workspace over when you create it.',
          { name }
        )}
        // Its Home is open by now, if it could open; the hand-over is its first turn there.
        onCreated={(bot) => {
          setMadeBotKey(botRefKey(bot))
          setPickedKey(botRefKey(bot))
          setBusy(true)
          void handOver(bot, 'home').then((done) => {
            setBusy(false)
            if (done) {
              closeHandToBot()
            } else {
              setStep('pick')
            }
          })
        }}
      />
    )
  }

  if (step === 'made') {
    return null
  }

  const count = agents.length
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          closeHandToBot()
        }
      }}
    >
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bots.handToBot.title', 'Hand {{name}} to a bot', { name })}</DialogTitle>
          <DialogDescription>
            {count === 0
              ? t('bots.handToBot.noAgents', 'It has no agents running.')
              : count === 1
                ? t('bots.handToBot.oneAgent', 'Its agent keeps running and works for the bot.')
                : t(
                    'bots.handToBot.agents',
                    'Its {{n}} agents keep running and work for the bot.',
                    {
                      n: count
                    }
                  )}
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              formRef.current?.requestSubmit()
            }
          }}
        >
          <div>
            {bots.length > FILTER_FROM ? <BotPickFilter value={query} onChange={setQuery} /> : null}
            <BotPickRows>
              <BotPickRow
                onClick={() => setStep('new')}
                picture={
                  <span className={NEW_BOT_TILE}>
                    <Plus className="size-3.5" />
                  </span>
                }
                name={t('bots.handToBot.newBot', 'New bot…')}
                detail={t('bots.handToBot.newBotNote', 'Set one up for this workspace')}
                on={false}
                trailing={<ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
              />
              <RadioGroup
                aria-label={t('bots.handToBot.pick', 'Bots')}
                value={pickedKey ?? ''}
                onValueChange={(key) => {
                  setPopped(key)
                  setPickedKey(key)
                }}
                layout="rows"
              >
                {shown.map((bot) => {
                  const has = owner !== null && isSameBot(bot, owner)
                  const key = botRefKey(bot)
                  return (
                    <RadioGroupItemSlot key={key} value={key} disabled={has}>
                      <BotPickRow
                        picture={<BotAvatar bot={bot} className="size-7 rounded-lg text-sm" />}
                        name={bot.name}
                        detail={purposes.get(botRefKey(bot)) ?? null}
                        on={key === pickedKey}
                        pop={popped === key}
                        trailing={
                          has ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('bots.handToBot.hasIt', 'Has it now')}
                            </span>
                          ) : null
                        }
                      />
                    </RadioGroupItemSlot>
                  )
                })}
              </RadioGroup>
            </BotPickRows>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hand-to-bot-goal">
              {t('bots.handToBot.goal', 'What should it do with this?')}
              <span className="font-normal text-muted-foreground">
                {t('bots.handToBot.optional', '(optional)')}
              </span>
            </Label>
            <Input
              id="hand-to-bot-goal"
              value={goal}
              maxLength={BOT_TAKE_OVER_GOAL_MAX}
              autoComplete="off"
              placeholder={t('bots.handToBot.goalPlaceholder', 'e.g. get it merged by Friday')}
              onChange={(event) => setGoal(event.target.value)}
            />
          </div>
          {owner && picked ? (
            <p className="flex items-start gap-2 text-xs leading-[18px] text-muted-foreground">
              <BotAvatar bot={owner} className="mt-px size-4 shrink-0 rounded text-[9px]" />
              <span>
                {t(
                  'bots.handToBot.moveNote',
                  '{{owner}} has this workspace now. Handing it over moves it, and its agents, to {{bot}}.',
                  { owner: owner.name, bot: picked.name }
                )}
              </span>
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs leading-[18px] text-destructive">
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end">
            <BotCreateButton type="submit" busy={busy} disabled={!picked || busy}>
              {owner && picked
                ? t('bots.handToBot.moveTo', 'Move to {{bot}}', { bot: picked.name })
                : t('bots.handToBot.handOver', 'Hand over')}
            </BotCreateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** What Orca tells the bot about the workspace: where it is and who works there. */
function useTakeOver(worktree: Worktree, agentTypes: readonly string[]): BotTakeOver {
  const project = useAppStore(
    (s) => s.repos.find((repo) => repo.id === worktree.repoId)?.displayName
  )
  const parsed = parseExecutionHostId(worktree.hostId)
  const environment = parsed?.kind === 'runtime' ? parsed.environmentId : undefined
  // A paired computer, by the name the owner gave it.
  const computer = useAppStore((s) =>
    environment ? s.runtimeEnvironments.find((entry) => entry.id === environment)?.name : undefined
  )
  const agents = agentTypes.join('\n')
  return useMemo(
    () => ({
      workspace: {
        id: worktree.id,
        name: worktree.displayName,
        ...(project ? { project } : {}),
        ...(computer ? { computer } : {}),
        ...(environment ? { environment } : {})
      },
      agents: agents ? agents.split('\n').map((type) => formatAgentTypeLabel(type)) : []
    }),
    [agents, computer, environment, project, worktree.displayName, worktree.id]
  )
}
