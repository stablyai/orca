import { Bot, GitFork } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { slugifyForWorkspaceName } from '../../../../../../shared/workspace-name'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { NativeChatForkRowAction, NativeChatWorktreeForkDialog } from './use-native-chat-fork'
import {
  nativeChatWorktreeForkPlan,
  nativeChatWorktreeForkSourceBranch,
  runNativeChatWorktreeFork,
  type NativeChatWorktreeForkBase
} from './native-chat-worktree-fork'

type DialogProps = {
  dialog: NativeChatWorktreeForkDialog | null
  sourceWorktreeId: string
  agent: TuiAgent
  request: NativeChatForkRowAction['request']
  /** The chat a subagent reports back to. */
  source: { target: RuntimeClientTarget; sessionId: string; label: string }
}

/** Asks for the fork's name and base (and a subagent's task), shows where it will go, then forks. */
export function NativeChatWorktreeForkDialogHost(props: DialogProps): React.JSX.Element | null {
  const { dialog } = props
  // Keyed per opening, so each one starts from the next free name and an empty task.
  return dialog ? (
    <WorktreeForkDialog key={`${dialog.throughItemId}:${dialog.mode}`} {...props} dialog={dialog} />
  ) : null
}

function WorktreeForkDialog({
  dialog,
  sourceWorktreeId,
  agent,
  request,
  source
}: DialogProps & { dialog: NativeChatWorktreeForkDialog }): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [plan] = useState(() => nativeChatWorktreeForkPlan(sourceWorktreeId))
  const [name, setName] = useState(plan?.name ?? '')
  const [base, setBase] = useState<NativeChatWorktreeForkBase>('main')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const branch = nativeChatWorktreeForkSourceBranch(sourceWorktreeId)
  const subagent = dialog.mode === 'subagent'
  const slug = slugifyForWorkspaceName(name)
  const ready = slug.length > 0 && (!subagent || task.trim().length > 0)
  const fork = (): void => {
    if (!ready) {
      return
    }
    void runWithBusyFlag(busyRef, setBusy, async () => {
      if (
        await runNativeChatWorktreeFork({
          sourceWorktreeId,
          base,
          agent,
          throughItemId: dialog.throughItemId,
          request,
          name: slug,
          // The person's name is the title; the default keeps its "Fork N of" wording.
          displayName: slug === plan?.name ? plan.displayName : name.trim(),
          mode: dialog.mode,
          ...(subagent ? { subagent: { ...source, task: task.trim() } } : {})
        })
      ) {
        dialog.close()
      }
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) {
          dialog.close()
        }
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {subagent
              ? t('components.native-chat.fork.subagent.title', 'Fork as a background subagent')
              : t('components.native-chat.fork.worktree.title', 'Fork into a new worktree')}
          </DialogTitle>
          <DialogDescription>
            {subagent
              ? t(
                  'components.native-chat.fork.subagent.description',
                  'A copy of this chat, up to this response, works on a task in its own worktree and reports back here. You keep working in this chat.'
                )
              : t(
                  'components.native-chat.fork.worktree.description',
                  'The new worktree opens a copy of this chat, up to this response, so you can take it another way. This chat stays as it is.'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>
            {t('components.native-chat.fork.worktree.nameLabel', 'Name')}
          </Label>
          <Input
            id={`${id}-name`}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          {plan && slug ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.native-chat.fork.worktree.where',
                'Folder {{folder}}, branch {{name}} (with your branch prefix)',
                { folder: `${plan.folder}/${slug}`, name: slug }
              )}
            </p>
          ) : null}
        </div>
        {subagent ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-task`}>
              {t('components.native-chat.fork.subagent.taskLabel', 'Task')}
            </Label>
            <Textarea
              id={`${id}-task`}
              value={task}
              disabled={busy}
              rows={4}
              placeholder={t(
                'components.native-chat.fork.subagent.taskPlaceholder',
                'What should the subagent do?'
              )}
              onChange={(event) => setTask(event.target.value)}
            />
          </div>
        ) : null}
        <RadioGroup
          value={base}
          onValueChange={(value) => {
            if (isWorktreeForkBase(value)) {
              setBase(value)
            }
          }}
          aria-label={t('components.native-chat.fork.worktree.baseLabel', 'Start the branch from')}
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem id={`${id}-main`} value="main" className="mt-0.5" />
            <div className="flex flex-col items-start gap-0.5">
              <Label htmlFor={`${id}-main`}>
                {t('components.native-chat.fork.worktree.baseMain', 'Main branch')}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t(
                  'components.native-chat.fork.worktree.baseMainHint',
                  'The project’s default base, like any new worktree.'
                )}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem
              id={`${id}-current`}
              value="current"
              disabled={!branch}
              className="mt-0.5"
            />
            <div className="flex flex-col items-start gap-0.5">
              <Label htmlFor={`${id}-current`}>
                {t('components.native-chat.fork.worktree.baseCurrent', 'This branch')}
              </Label>
              <span className="text-xs text-muted-foreground">
                {branch
                  ? t(
                      'components.native-chat.fork.worktree.baseCurrentHint',
                      '{{branch}}, as last committed. Uncommitted changes stay here.',
                      { branch }
                    )
                  : t(
                      'components.native-chat.fork.worktree.baseCurrentUnavailable',
                      'This workspace has no branch to start from.'
                    )}
              </span>
            </div>
          </div>
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={dialog.close}>
            {t('components.native-chat.fork.worktree.cancel', 'Cancel')}
          </Button>
          <Button disabled={busy || !ready} onClick={fork}>
            {subagent ? <Bot className="size-4" /> : <GitFork className="size-4" />}
            {busy
              ? t('components.native-chat.fork.worktree.creating', 'Creating worktree…')
              : subagent
                ? t('components.native-chat.fork.subagent.confirm', 'Start subagent')
                : t('components.native-chat.fork.worktree.confirm', 'Fork')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Narrows a radio value to a fork base. */
function isWorktreeForkBase(value: string): value is NativeChatWorktreeForkBase {
  return value === 'main' || value === 'current'
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
