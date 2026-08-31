import type { ForwardedRef, ReactNode } from 'react'
import { act, forwardRef } from 'react'

export let setCommandQuery: ((next: string) => void) | null = null
export let setCommandSelection: ((next: string) => void) | null = null

export function resetPaletteCommandSelection(): void {
  setCommandQuery = null
  setCommandSelection = null
}

export async function createPaletteCommandMocks(): Promise<Record<string, unknown>> {
  return {
    Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      setCommandSelection = commandProps?.onValueChange ?? null
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange,
      placeholder
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
      )
    },
    CommandList: forwardRef(function CommandList(
      { children }: { children: ReactNode },
      ref: ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
}

export async function flushPaletteEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

export function getWorktreeRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-command-item^="worktree:"]')].map(
    (node) => node.textContent ?? ''
  )
}

export function getRenderedRowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
  )
}

/** The id cmdk would activate on Enter. */
export function getCommandValue(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('[data-command-dialog]')?.dataset.commandValue ?? ''
}

export function getTabRowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')].map(
    (node) => (node.dataset.commandItem ?? '').replace('workspace-tab:', '')
  )
}

export function getTabRowShortcutDigits(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')
  ].flatMap((row) =>
    [...row.querySelectorAll<HTMLElement>('span')]
      .map((node) => node.textContent ?? '')
      .filter((text) => /^\d+$/.test(text))
  )
}

export function clickSeeMore(container: HTMLElement): void {
  ;[...container.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('See more'))
    ?.click()
}
