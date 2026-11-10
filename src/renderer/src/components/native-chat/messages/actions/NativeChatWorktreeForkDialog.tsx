import { GitFork } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatForkRowAction, NativeChatWorktreeForkDialog } from './use-native-chat-fork'
import {
  nativeChatWorktreeForkSourceBranch,
  runNativeChatWorktreeFork,
  type NativeChatWorktreeForkBase
} from './native-chat-worktree-fork'

/** Asks where the new worktree branches from, then forks the chat into it. */
export function NativeChatWorktreeForkDialogHost({
  dialog,
  sourceWorktreeId,
  agent,
  request
}: {
  dialog: NativeChatWorktreeForkDialog | null
  sourceWorktreeId: string
  agent: TuiAgent
  request: NativeChatForkRowAction['request']
}): React.JSX.Element | null {
  const t = useTranslate()
  const id = useId()
  const [base, setBase] = useState<NativeChatWorktreeForkBase>('main')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  if (!dialog) {
    return null
  }
  const branch = nativeChatWorktreeForkSourceBranch(sourceWorktreeId)
  const close = (): void => {
    setBase('main')
    dialog.close()
  }
  const fork = (): void => {
    void runWithBusyFlag(busyRef, setBusy, async () => {
      if (
        await runNativeChatWorktreeFork({
          sourceWorktreeId,
          base,
          agent,
          throughItemId: dialog.throughItemId,
          request
        })
      ) {
        close()
      }
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) {
          close()
        }
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('components.native-chat.fork.worktree.title', 'Fork into a new worktree')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.native-chat.fork.worktree.description',
              'The new worktree opens a copy of this chat, up to this response, so you can take it another way. This chat stays as it is.'
            )}
          </DialogDescription>
        </DialogHeader>
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
              <span className="text-xs font-normal text-muted-foreground">
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
              <span className="text-xs font-normal text-muted-foreground">
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
          <Button variant="outline" disabled={busy} onClick={close}>
            {t('components.native-chat.fork.worktree.cancel', 'Cancel')}
          </Button>
          <Button disabled={busy} onClick={fork}>
            <GitFork className="size-4" />
            {busy
              ? t('components.native-chat.fork.worktree.creating', 'Creating worktree…')
              : t('components.native-chat.fork.worktree.confirm', 'Fork')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
