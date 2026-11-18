import { Button } from '@/components/ui/button'

export function NativeChatActionButton({
  primary = false,
  label,
  children,
  href,
  disabled,
  onClick
}: {
  primary?: boolean
  label?: string
  children?: React.ReactNode
  href?: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  const content = children ?? label
  return (
    <Button
      type={href ? undefined : 'button'}
      variant={primary ? 'default' : 'outline'}
      size={primary ? 'lg' : 'xs'}
      className={primary ? 'h-auto min-h-10 max-w-full whitespace-normal' : undefined}
      asChild={Boolean(href)}
      disabled={disabled}
      onClick={(event) => {
        if (href) {
          event.preventDefault()
        }
        onClick()
      }}
    >
      {href ? <a href={href}>{content}</a> : content}
    </Button>
  )
}
