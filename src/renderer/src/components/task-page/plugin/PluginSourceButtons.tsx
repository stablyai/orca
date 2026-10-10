import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { usePluginTaskSources } from '@/store/plugin-task-sources'
import { resolvePluginPanelIcon } from '@/components/right-sidebar/plugin-panel-activity-items'
import { TaskPageSourceIconButton } from '../SourceIconButton'

/** Source tabs contributed by enabled plugins; picking one is remembered for the next bare open. */
export function TaskPagePluginSourceButtons({
  activeKey
}: {
  activeKey: string | null
}): React.JSX.Element | null {
  const { sources } = usePluginTaskSources()
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (sources.length === 0) {
    return null
  }
  return (
    <>
      {sources.map((source) => {
        const Icon = resolvePluginPanelIcon(source.icon)
        return (
          <TaskPageSourceIconButton
            key={source.key}
            label={source.title}
            active={source.key === activeKey}
            dataTaskSource={`plugin:${source.key}`}
            onSelect={() => {
              openTaskPage(
                { pluginTaskSource: { pluginKey: source.pluginKey, sourceId: source.sourceId } },
                { recordTasksInteraction: false }
              )
              void updateSettings({ defaultPluginTaskSource: source.key }).catch(() => {
                toast.error(
                  translate(
                    'auto.components.TaskPage.609532fae7',
                    'Failed to save default task source.'
                  )
                )
              })
            }}
          >
            <Icon className="size-3.5" />
          </TaskPageSourceIconButton>
        )
      })}
    </>
  )
}
