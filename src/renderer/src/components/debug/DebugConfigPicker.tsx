import type React from 'react'
import { useRef } from 'react'
import type { DebugLaunchConfigListing } from '../../../../preload/api/debug-api'
import { translate } from '@/i18n/i18n'

export type DebugConfigChoice = { kind: 'config'; name: string } | { kind: 'current-file' }

type DebugConfigPickerProps = {
  configs: DebugLaunchConfigListing[]
  /** launch.json's refusal (line:column for a malformed file); no configuration can run. */
  launchError: string | null
  /** Shown only when the active file's language has a default adapter. */
  currentFile: { name: string } | null
  selected: DebugConfigChoice | null
  onSelect: (choice: DebugConfigChoice) => void
}

export function isSameDebugChoice(a: DebugConfigChoice | null, b: DebugConfigChoice): boolean {
  if (a === null || a.kind !== b.kind) {
    return false
  }
  return a.kind === 'current-file' || (b.kind === 'config' && a.name === b.name)
}

/** The first runnable choice, so the Start button works without a pick. */
export function defaultDebugChoice(
  configs: DebugLaunchConfigListing[],
  currentFile: { name: string } | null
): DebugConfigChoice | null {
  const runnable = configs.find((config) => config.runnable)
  if (runnable) {
    return { kind: 'config', name: runnable.name }
  }
  return currentFile ? { kind: 'current-file' } : null
}

export function DebugConfigPicker({
  configs,
  launchError,
  currentFile,
  selected,
  onSelect
}: DebugConfigPickerProps): React.JSX.Element {
  const groupRef = useRef<HTMLDivElement>(null)
  if (launchError) {
    return (
      <div role="alert" className="px-3 py-2 text-xs text-destructive">
        <div className="font-medium">
          {translate('debug.picker.launchJsonError', 'launch.json could not be read')}
        </div>
        <div className="mt-0.5 font-mono break-words">{launchError}</div>
      </div>
    )
  }
  if (configs.length === 0 && !currentFile) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {translate(
          'debug.picker.empty',
          'No launch configurations. Add .vscode/launch.json or open a file to debug.'
        )}
      </div>
    )
  }
  const choices: { choice: DebugConfigChoice; runnable: boolean }[] = [
    ...configs.map((config) => ({
      choice: { kind: 'config' as const, name: config.name },
      runnable: config.runnable
    })),
    ...(currentFile ? [{ choice: { kind: 'current-file' as const }, runnable: true }] : [])
  ]
  const enabled = choices.filter((c) => c.runnable)
  // Roving tabindex: the group is one tab stop, on the checked row or else the first runnable one.
  const focusIndex = Math.max(
    0,
    enabled.findIndex((c) => isSameDebugChoice(selected, c.choice))
  )
  const tabStop = enabled[focusIndex]?.choice ?? null
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : null
    if ((delta === undefined && edge === null) || enabled.length === 0) {
      return
    }
    event.preventDefault()
    const index = edge ?? (focusIndex + (delta ?? 0) + enabled.length) % enabled.length
    onSelect(enabled[index].choice)
    const rows = [
      ...(groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
    ]
    rows.filter((row) => !row.disabled)[index]?.focus()
  }
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={translate('debug.picker.label', 'Launch configuration')}
      className="flex flex-col py-1"
      onKeyDown={onKeyDown}
    >
      {configs.map((config) => {
        const choice = { kind: 'config' as const, name: config.name }
        return (
          <ChoiceRow
            key={`config:${config.name}`}
            label={config.name}
            detail={config.runnable ? config.type : (config.refusal ?? null)}
            refused={!config.runnable}
            checked={isSameDebugChoice(selected, choice)}
            tabStop={isSameDebugChoice(tabStop, choice)}
            onSelect={() => onSelect(choice)}
          />
        )
      })}
      {currentFile ? (
        <ChoiceRow
          label={translate('debug.picker.currentFile', 'Debug current file')}
          detail={currentFile.name}
          refused={false}
          checked={isSameDebugChoice(selected, { kind: 'current-file' })}
          tabStop={isSameDebugChoice(tabStop, { kind: 'current-file' })}
          onSelect={() => onSelect({ kind: 'current-file' })}
        />
      ) : null}
    </div>
  )
}

function ChoiceRow({
  label,
  detail,
  refused,
  checked,
  tabStop,
  onSelect
}: {
  label: string
  detail: string | null
  refused: boolean
  checked: boolean
  tabStop: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={refused}
      tabIndex={tabStop ? 0 : -1}
      onClick={onSelect}
      className="flex w-full flex-col items-start gap-0.5 px-3 py-1 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent aria-checked:bg-accent"
    >
      <span className="truncate">{label}</span>
      {detail ? <span className="text-xs break-words text-muted-foreground">{detail}</span> : null}
    </button>
  )
}
