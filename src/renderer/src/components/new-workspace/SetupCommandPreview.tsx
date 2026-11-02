export function SetupCommandPreview({
  setupConfig
}: {
  setupConfig: { command: string }
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/60 bg-muted/40 shadow-inner">
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-foreground/90 scrollbar-sleek">
        {setupConfig.command}
      </pre>
    </div>
  )
}
