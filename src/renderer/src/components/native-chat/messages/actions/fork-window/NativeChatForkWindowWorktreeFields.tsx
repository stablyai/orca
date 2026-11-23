import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatWorktreeForkBase } from '../native-chat-worktree-fork'

/** Narrows a radio value to a fork base. */
function isWorktreeForkBase(value: string): value is NativeChatWorktreeForkBase {
  return value === 'main' || value === 'current'
}

/** The new worktree's name and the branch it starts from. */
export function NativeChatForkWindowWorktreeFields({
  id,
  name,
  slug,
  base,
  branch,
  busy,
  onNameChange,
  onBaseChange
}: {
  id: string
  name: string
  slug: string
  base: NativeChatWorktreeForkBase
  /** The source's branch; null when the new worktree can only start from main. */
  branch: string | null
  busy: boolean
  onNameChange: (name: string) => void
  onBaseChange: (base: NativeChatWorktreeForkBase) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>
          {t('components.native-chat.fork.worktree.nameLabel', 'Name')}
        </Label>
        <Input
          id={`${id}-name`}
          value={name}
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
        />
        {slug ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.native-chat.fork.worktree.whereName',
              'The worktree’s folder and branch are named {{name}} (the branch with your prefix). The exact folder and branch show once it’s created.',
              { name: slug }
            )}
          </p>
        ) : null}
      </div>
      <RadioGroup
        value={base}
        disabled={busy}
        onValueChange={(value) => {
          if (isWorktreeForkBase(value)) {
            onBaseChange(value)
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
                    { branch: branch.replace(/^refs\/heads\//, '') }
                  )
                : t(
                    'components.native-chat.fork.worktree.baseCurrentUnavailable',
                    'This workspace has no branch to start from.'
                  )}
            </span>
          </div>
        </div>
      </RadioGroup>
    </>
  )
}
