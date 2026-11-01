export function NativeChatSessionOptionChoiceBody(props: {
  label: string
  description?: string
  detail?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 py-0.5">
      <div>{props.label}</div>
      {props.description ? (
        <div className="text-xs font-normal text-balance text-muted-foreground">
          {props.description}
        </div>
      ) : null}
      {props.detail ? (
        <div className="text-xs font-normal text-balance text-muted-foreground">{props.detail}</div>
      ) : null}
    </div>
  )
}
