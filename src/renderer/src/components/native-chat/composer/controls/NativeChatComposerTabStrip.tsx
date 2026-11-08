/** A one-line strip that sits on the composer's top edge like a tab (thread goal, temporary worker). */
export function NativeChatComposerTabStrip({
  children,
  ...dataAttributes
}: {
  children: React.ReactNode
} & Record<`data-${string}`, string>): React.JSX.Element {
  return (
    // Pulled over the composer's top padding so the strip sits on the input box.
    <div
      className="group/goal relative -mb-2 shrink-0 px-3 sm:px-4 [[data-native-chat-composer-tab-strip]+&]:mt-2"
      data-native-chat-composer-tab-strip=""
      {...dataAttributes}
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-2">
        {/* Right after the task strip, that strip's bottom border is this tab's top edge; stacked tabs square off. */}
        <div className="flex items-start gap-2 rounded-t-md border border-b-0 border-border bg-muted/30 py-1 pr-1 pl-3 text-xs text-muted-foreground group-[[data-native-chat-background-tasks]+&]/goal:rounded-t-none group-[[data-native-chat-background-tasks]+&]/goal:border-t-0 group-[[data-native-chat-composer-tab-strip]+&]/goal:rounded-t-none">
          {children}
        </div>
      </div>
    </div>
  )
}
