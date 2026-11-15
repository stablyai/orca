import { Button } from '@/components/ui/button'

/** The agent chat: a person's message, a reply with inline code, a code block and a link. */
export function SpecimenChat(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 text-[13px]">
      <div className="text-[11px] font-medium tracking-wide uppercase text-muted-foreground">
        Agent
      </div>
      <div
        className="self-end rounded-xl px-3 py-2"
        style={{ background: 'var(--chat-user-message, var(--muted))' }}
      >
        Welcome returning visitors back.
      </div>
      <div>
        Updated{' '}
        <code
          className="rounded px-1 font-mono text-[12px]"
          style={{
            background: 'var(--chat-inline-code, var(--muted))',
            color: 'var(--chat-inline-code-foreground, var(--foreground))'
          }}
        >
          greet()
        </code>
        . <b style={{ color: 'var(--chat-bold-foreground, var(--foreground))' }}>Tests pass.</b>{' '}
        <span style={{ color: 'var(--text-link)' }}>View diff</span>
      </div>
      <pre
        className="rounded-lg p-2 font-mono text-[12px]"
        style={{ background: 'var(--chat-code-block, var(--muted))' }}
      >
        return `Welcome back`
      </pre>
      <div style={{ color: 'var(--chat-muted-foreground, var(--muted-foreground))' }}>
        Ran npm test · 2s
      </div>
    </div>
  )
}

/** A dialog over the chat: popover surface, border and the three button kinds. */
export function SpecimenDialog(): React.JSX.Element {
  return (
    <div className="m-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-floating">
      <div className="text-[13px] font-semibold">Keep this theme?</div>
      <div className="mt-1 text-[12px] text-muted-foreground">
        It is saved as one of your themes.
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm">Keep</Button>
        <Button size="sm" variant="secondary">
          Undo
        </Button>
        <Button size="sm" variant="ghost">
          Discard
        </Button>
      </div>
    </div>
  )
}
