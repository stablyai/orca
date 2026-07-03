import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'

export type JiraServerAuthMode = 'basic' | 'bearer'

type JiraServerAuthFieldsProps = {
  authMode: JiraServerAuthMode
  onAuthModeChange: (value: JiraServerAuthMode) => void
  username: string
  onUsernameChange: (value: string) => void
  passwordOrToken: string
  onPasswordOrTokenChange: (value: string) => void
  bearerToken: string
  onBearerTokenChange: (value: string) => void
  usernameId: string
  passwordOrTokenId: string
  bearerTokenId: string
  disabled: boolean
  hasError: boolean
  errorId: string
}

export function JiraServerAuthFields({
  authMode,
  onAuthModeChange,
  username,
  onUsernameChange,
  passwordOrToken,
  onPasswordOrTokenChange,
  bearerToken,
  onBearerTokenChange,
  usernameId,
  passwordOrTokenId,
  bearerTokenId,
  disabled,
  hasError,
  errorId
}: JiraServerAuthFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="space-y-2">
        <Label className="text-xs">
          {translate('auto.components.jira.connect.dialog.authMode', 'Auth mode')}
        </Label>
        <ToggleGroup
          type="single"
          value={authMode}
          onValueChange={(value) => {
            if (value === 'basic' || value === 'bearer') {
              onAuthModeChange(value)
            }
          }}
          variant="outline"
          size="sm"
          className="w-full"
        >
          <ToggleGroupItem value="basic" className="flex-1">
            {translate('auto.components.jira.connect.dialog.basicAuth', 'Username + password/PAT')}
          </ToggleGroupItem>
          <ToggleGroupItem value="bearer" className="flex-1">
            {translate('auto.components.jira.connect.dialog.bearerAuth', 'Bearer PAT')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {authMode === 'basic' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={usernameId} className="text-xs">
              {translate('auto.components.jira.connect.dialog.username', 'Username')}
            </Label>
            <Input
              id={usernameId}
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={passwordOrTokenId} className="text-xs">
              {translate(
                'auto.components.jira.connect.dialog.passwordOrToken',
                'Password or token'
              )}
            </Label>
            <Input
              id={passwordOrTokenId}
              type="password"
              value={passwordOrToken}
              onChange={(event) => onPasswordOrTokenChange(event.target.value)}
              disabled={disabled}
              aria-invalid={hasError}
              aria-describedby={hasError ? errorId : undefined}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={bearerTokenId} className="text-xs">
            {translate('auto.components.jira.connect.dialog.bearerToken', 'Bearer token')}
          </Label>
          <Input
            id={bearerTokenId}
            type="password"
            value={bearerToken}
            onChange={(event) => onBearerTokenChange(event.target.value)}
            disabled={disabled}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : undefined}
          />
        </div>
      )}
    </>
  )
}
