export function ManagedRuntimeLinkButton(
  props: Omit<React.ComponentProps<'button'>, 'className' | 'type'>
): React.JSX.Element {
  return (
    <button
      type="button"
      className="rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      {...props}
    />
  )
}
