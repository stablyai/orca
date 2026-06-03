import type { JSX, RefObject } from 'react'
import { cn } from '@/lib/utils'

type SetupScriptNewWorkspaceModalProps = {
  visible: boolean
  nameValue: string
  nameTyping: boolean
  createHovered: boolean
  createClicked: boolean
  createButtonRef: RefObject<HTMLDivElement | null>
}

export function SetupScriptNewWorkspaceModal({
  visible,
  nameValue,
  nameTyping,
  createHovered,
  createClicked,
  createButtonRef
}: SetupScriptNewWorkspaceModalProps): JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/55 backdrop-blur-[1px] transition-opacity duration-300 z-40',
        visible ? 'opacity-100' : 'opacity-0'
      )}
      aria-hidden
    >
      <div
        className={cn(
          'relative w-[min(240px,92%)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg transition-[opacity,transform] duration-300',
          visible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.98] opacity-0'
        )}
      >
        <div className="text-xs font-semibold leading-none text-foreground">Create Worktree</div>
        <div className="mt-2.5 space-y-1.5">
          <SetupScriptModalField label="Project" value="orca" />
          <SetupScriptModalField label="Name" value={nameValue} typing={nameTyping} />
          <SetupScriptModalField label="Agent" value="Codex" />
        </div>
        <div
          ref={createButtonRef}
          className={cn(
            'mt-3 flex h-7 w-full items-center justify-center rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground transition-all duration-200',
            createHovered ? 'opacity-90' : null,
            createClicked ? 'scale-[0.98]' : null
          )}
        >
          Create worktree
        </div>
      </div>
    </div>
  )
}

function SetupScriptModalField(props: {
  label: string
  value: string
  typing?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px]">
      <span className="text-muted-foreground">{props.label}</span>
      <div className="flex items-center font-mono font-medium text-foreground min-w-0">
        <span className="truncate">{props.value}</span>
        {props.typing ? (
          <span className="ml-px inline-block h-2.5 w-[5px] animate-pulse bg-foreground" />
        ) : null}
      </div>
    </div>
  )
}
