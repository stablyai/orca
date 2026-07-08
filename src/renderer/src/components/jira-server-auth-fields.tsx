import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { JiraAuthMode } from '../../../shared/types'

export type JiraServerAuthMode = JiraAuthMode

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
          {translate('auto.components.jira.server.auth.fields.babc323094', 'Auth mode')}
        </Label>
        <ToggleGroup
          type="single"
          value={authMode}
          disabled={disabled}
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
            {translate(
              'auto.components.jira.server.auth.fields.007396fe30',
              'Username + password/PAT'
            )}
          </ToggleGroupItem>
          <ToggleGroupItem value="bearer" className="flex-1">
            {translate('auto.components.jira.server.auth.fields.bfc1a4ebc6', 'Bearer PAT')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {authMode === 'basic' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={usernameId} className="text-xs">
              {translate('auto.components.jira.server.auth.fields.cfd0fe8fe2', 'Username')}
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
              {translate('auto.components.jira.server.auth.fields.61b0dd9ad7', 'Password or token')}
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
            {translate('auto.components.jira.server.auth.fields.ccf0daaaa7', 'Bearer token')}
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
