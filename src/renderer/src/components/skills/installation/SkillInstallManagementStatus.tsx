export function SkillInstallManagementStatus(props: {
  resultLabel: string | null
  progressLabel: string | null
  error: string | null
  notice: string | null
}): React.JSX.Element {
  return (
    <>
      {props.resultLabel ? (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {props.resultLabel}
        </p>
      ) : null}
      {props.progressLabel ? (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {props.progressLabel}
        </p>
      ) : null}
      {props.error ? (
        <p className="text-xs text-destructive" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.notice ? (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {props.notice}
        </p>
      ) : null}
    </>
  )
}
