import syntheticIconUrl from '../../../../../resources/synthetic-icon.svg?url'

export function SyntheticIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={syntheticIconUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="block shrink-0"
      style={{ width: size, height: size }}
    />
  )
}
