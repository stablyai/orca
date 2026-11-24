import giteaLogo from '@/assets/gitea.svg'

export function GiteaIcon({ className }: { className?: string }): React.JSX.Element {
  return <img src={giteaLogo} alt="" aria-hidden className={className} />
}
