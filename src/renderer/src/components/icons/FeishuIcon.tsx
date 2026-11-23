import feishuLogo from '@/assets/connector-brands/feishu.svg'

// Feishu Open Platform's small mark, including its original background for dark surfaces.
export function FeishuIcon({ className }: { className?: string }): React.JSX.Element {
  return <img src={feishuLogo} alt="" aria-hidden="true" draggable={false} className={className} />
}
