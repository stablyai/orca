import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type {
  CloudTokenKind,
  JiraConnectMode,
  JiraInstanceType,
  ServerAuthMethod
} from './jira-connect-mode'

type JiraConnectModeTogglesProps = {
  mode: JiraConnectMode
  disabled: boolean
  onChange: (mode: JiraConnectMode) => void
}

const ITEM_CLASS = 'h-8 px-3 text-xs'

/** Deployment + credential-kind pickers; every change is a whole-mode update. */
export function JiraConnectModeToggles({
  mode,
  disabled,
  onChange
}: JiraConnectModeTogglesProps): React.JSX.Element {
  const guard = (apply: (value: string) => void) => (value: string) => {
    if (!value || disabled) {
      return
    }
    apply(value)
  }
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={mode.instanceType}
        disabled={disabled}
        onValueChange={guard((value) =>
          onChange({ ...mode, instanceType: value as JiraInstanceType })
        )}
        aria-label={translate(
          'auto.components.jira.connect.dialog.b67e919bd5',
          'Jira instance type'
        )}
      >
        <ToggleGroupItem value="cloud" className={ITEM_CLASS}>
          {translate('auto.components.jira.connect.dialog.17787d6e4b', 'Atlassian Cloud')}
        </ToggleGroupItem>
        <ToggleGroupItem value="server" className={ITEM_CLASS}>
          {translate('auto.components.jira.connect.dialog.bc7a831773', 'Self-hosted')}
        </ToggleGroupItem>
      </ToggleGroup>
      {mode.instanceType === 'cloud' ? (
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode.cloudTokenKind}
          disabled={disabled}
          onValueChange={guard((value) =>
            onChange({ ...mode, cloudTokenKind: value as CloudTokenKind })
          )}
          aria-label={translate(
            'auto.components.jira.connect.dialog.4823d0100d',
            'Cloud token type'
          )}
        >
          <ToggleGroupItem value="classic" className={ITEM_CLASS}>
            {translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')}
          </ToggleGroupItem>
          <ToggleGroupItem value="scoped" className={ITEM_CLASS}>
            {translate('auto.components.jira.connect.dialog.327c8aeb62', 'Scoped API token')}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : (
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode.serverAuthMethod}
          disabled={disabled}
          onValueChange={guard((value) =>
            onChange({ ...mode, serverAuthMethod: value as ServerAuthMethod })
          )}
          aria-label={translate(
            'auto.components.jira.connect.dialog.f49708c369',
            'Jira authentication method'
          )}
        >
          <ToggleGroupItem value="pat" className={ITEM_CLASS}>
            {translate('auto.components.jira.connect.dialog.730d973bae', 'Personal access token')}
          </ToggleGroupItem>
          <ToggleGroupItem value="basic" className={ITEM_CLASS}>
            {translate('auto.components.jira.connect.dialog.84a810dd0e', 'Username & password')}
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    </>
  )
}
